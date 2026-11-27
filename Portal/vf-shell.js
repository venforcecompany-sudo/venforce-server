// Portal/vf-shell.js
//
// Shell V3 (F0.5) — MASTER_SPEC §5 (contrato do shell), §9 (sidebar
// completa), §14 (marketplace × capacidade), §19 (responsividade).
//
// Responsabilidades (e só estas):
//   · ler data-vf-scope / data-vf-module / data-vf-marketplaces / data-vf-capability
//   · montar a sidebar de coluna única (logo, contexto, módulos, gestão
//     global, administração, rodapé)
//   · montar os dois dropdowns (Cliente, Operação) e refletir vf-context
//   · aplicar o gating (esconder `main`, mostrar o painel de estado)
//   · reparentar o bloco de contexto em telas estreitas (§19.1) — um nó só
//   · publicar window.VF.shell — espelho, nunca fonte
//
// NÃO decide cardinalidade (vf-context.js, e só lá — R8), não decide acesso
// (403 é estado, não filtro — I10), não busca dado de módulo. Portado de
// Squads_migration/preview_v3/js/vf-shell.js, adaptado para: (a) ES module
// real (vf-context.js exporta statusOperacao/rotuloExterno diretamente, sem
// namespace `contextFactory`); (b) wiring real com vf-api.js — o rascunho
// usava um mock; (c) fabricação do DOM da página migrada (o rascunho tinha
// mount points fixos no harness do protótipo; aqui a página real só troca 3
// atributos, então o shell precisa construir `.vf-shell` em volta do
// conteúdo existente, sem reescrevê-lo).
//
// ES Module. Espelhado em window.VF.shell.

import { vfContext } from "./vf-context.js";
import { vfApi } from "./vf-api.js";
import { format as fmt } from "./vf-format.js";
import { statusOperacao, rotuloExterno } from "./vf-context.js";
import { loadUnificacaoAccess } from "./clientes-unificacao-access.js";

const TOKEN_KEY = "vf-token";
const USER_KEY = "vf-user";
const COLLAPSE_KEY = "vf-sidebar-collapsed"; // preferência de UI (§9.2) — localStorage é correto AQUI

/* ── Modelo de navegação (MASTER_SPEC §9.5) ──────────────────────────────
   30 links em 5 grupos incoerentes → 8 módulos contextuais + globais +
   admin. `rota: null` (nenhum módulo usa isso hoje) continua suportado pelo
   render() abaixo — vira item desabilitado com "ainda não disponível nesta
   versão", nunca link quebrado. `marketplaces` ausente = disponível em
   todos os marketplaces. */
export const MODULOS = [
  { id: "visao", label: "Início", rota: "visao.html" },
  // Recuperação de navegação (VENFORCE_AUDITORIA_FORENSE_RECUPERACAO_TELAS.md
  // §8) — cliente-360-react.html é a Cliente 360 V2 REAL (não confundir com
  // o bundle Vue órfão `cliente-360-v2.html`, sem fonte, nunca linkado em
  // nenhuma origem). A própria página documenta o contrato de deep-link em
  // frontend-react/src/hooks/useCliente360.js:8-9 — por isso `linkParams`
  // manda `slug`/`marketplace`, nunca `cliente`/`conta` (semântica
  // diferente, o hook nem lê esses nomes).
  { id: "cliente-360-v2", label: "Cliente 360 V2", rota: "cliente-360-react.html", linkParams: linkParamsCliente360V2 },
  // FASE 1 (Projeto_cliente360) — fundação da nova Cliente 360 V3, sobre o
  // mesmo Shell V3 desta sidebar (vf-context/vf-shell) — mesmo padrão de
  // "visao" acima: nasce de Cliente+Operação já escolhidos aqui, não
  // precisa de linkParams (contexto vem de vf-context.js, não da URL).
  // V1 e V2 seguem por URL; apenas a V3 aparece na sidebar.
  { id: "cliente-360-v3", label: "Cliente 360", rota: "cliente-360-v3.html" },
  // Convergência #4 §15 — Financeiro V3 é o destino para MELI/Shopee (D-8/
  // D-9 não afetam isto: contrato já existe para os dois hoje). Marketplace
  // não suportado por V3 (TikTok legado) ou sem conta resolvida cai em
  // `rota` (o legado) — nunca fica sem destino algum. Ver resolverRota().
  { id: "financeiro", label: "Financeiro", rota: "financeiro.html", rotaPorMarketplace: { meli: "financeiro-v3.html", shopee: "financeiro-v3.html" } },
  // Central de Vendas: no grupo Performance para todos os perfis (27/11/2026). Ler é
  // requireAutomacoesAccess na API; sincronizar segue requireAdmin.
  { id: "central-vendas", label: "Central de Vendas", rota: "fechamentos-api.html" },
  { id: "ads", label: "Ads", rota: "ads.html", marketplaces: ["meli"] },
  { id: "anuncios", label: "Anúncios", rota: "anuncios-meli.html", marketplaces: ["meli"] },
  // Central do Full (modelo C): ilha React que lê Cliente+Operação do
  // vf-context.js (useOperacaoAtual), como a Visão — sem seletor próprio
  // desde então. Full é logística do Mercado Livre.
  { id: "central-full", label: "Central Full", rota: "full-gestao.html", marketplaces: ["meli"] },
  // F2.3 — Motor de Margem só resolve base MELI (contextoPrecificacaoService);
  // achado lendo o código real, não previsto no MASTER_SPEC original.
  { id: "margem", label: "Margem", rota: "central-margem.html", marketplaces: ["meli"] },
  { id: "diagnosticos", label: "Diagnósticos", rota: "diagnostico-inicial.html" },
  { id: "automacoes", label: "Automações", rota: "automacoes.html", marketplaces: ["meli"] },
];

// Espelho da regra do BACKEND do Sentinel (sentinelAcesso.papelPermitido = authorizationService.ehAdmin
// || ehInterno, com os internos de server/services/squads/rolesInternas.js: user, membro, interno).
// Só decide se o item aparece; quem autoriza continua sendo a API (403). seller já é desviado p/ seller.html.
export const PAPEIS_SENTINEL = Object.freeze(["admin", "user", "membro", "interno"]);

export const GLOBAIS = [
  // Painel de Controle de Contas por Squad — carteira agrupada por Squad,
  // hierarquia Cliente → Mês → Semana (lazy). GLOBAL como Carteira: tem
  // seletor próprio (ano/squad/busca), nunca exige Cliente+Operação
  // escolhidos antes (Auditoria Painel_Controle_Contas_Squads §13/§16).
  { id: "painel-contas", label: "Painel de Contas", rota: "painel-contas.html" },
  { id: "bases", label: "Bases", rota: "bases.html" },
  // Sentinel — fila de incidentes (margem/custo/leitura) por carteira. GLOBAL como
  // Carteira/Painel de Contas: filtra por Squad/conta na própria tela e aceita
  // ?cliente=&conta= como pré-filtro; a autorização é toda da API /sentinel.
  { id: "sentinel", label: "Sentinel", rota: "sentinel.html", papeis: PAPEIS_SENTINEL },
  // VenForce Resgate — auditoria financeira multiconta (carteira → conta → anúncio).
  // GLOBAL: escolhe a conta na própria tela; a API filtra pela carteira.
  { id: "resgate", label: "Resgate", rota: "resgate.html" },
  // Recuperação de navegação (auditoria forense, seção 6.2/15) — estas 5
  // telas têm arquivo, backend e lógica ativos em ATUAL; só perderam a
  // entrada de menu quando o Shell V3 chegou. Nenhuma delas lê `cliente`/
  // `conta`/`periodo` da URL (cada uma tem seletor de cliente próprio, na
  // própria página) — por isso GLOBAIS, não MODULOS: exigir cliente+operação
  // escolhidos na barra lateral antes de abri-las seria uma trava nova que essas
  // páginas nunca tiveram.
  { id: "cliente-operacao", label: "Cliente Operação", rota: "cliente-operacao.html" },
  { id: "cliente-360", label: "Cliente 360", rota: "cliente-360.html" },
  { id: "promocoes-ml", label: "Promoções ML", rota: "promocoes-retorno.html" },
  { id: "curva-abc", label: "Curva ABC", rota: "fechamento.html" },
  { id: "clientes-contas", label: "Clientes e Contas", rota: "clientes.html" },
  { id: "ferramentas", label: "Ferramentas", rota: "ferramentas.html" },
  // 05a67f1 migrou relatorios.html para o Shell V3 sem entrada na sidebar
  // "de propósito", para não decidir arquitetura de navegação sozinho — o
  // MASTER_SPEC (§ "absorver → Financeiro › Relatórios") ainda planeja isto
  // como aba do Financeiro, não como item próprio. Enquanto essa absorção
  // não existe, o Hub é uma capacidade migrada e funcional sem NENHUM
  // caminho de navegação primário (só chegava por link direto de
  // automacoes.js) — bug de produção. Reintroduzido aqui como global
  // (mesmo escopo de bases.html, decidido em 05a67f1); remover quando a
  // aba Financeiro › Relatórios existir de verdade.
  { id: "relatorios", label: "Relatórios", rota: "relatorios.html" },
  { id: "pessoas", label: "Pessoas", rota: "usuarios.html" },
  { id: "guia", label: "Guia do Vendedor", rota: "guia-vendedor.html" },
];

export const ADMIN = [
  { id: "clientes-unificacao", label: "Unificação de Clientes", rota: "clientes-unificacao.html", unificacaoUi: true },
  // Tokens ML era `adminOnly` em layout.js (e ml-tokens.js:12 já redireciona
  // sozinho quem não é admin) — recuperado só aqui, no grupo Administração,
  // para preservar exatamente a mesma restrição de acesso que já existia.
  // NENHUMA lógica de Tokens ML foi tocada (achado de segurança da auditoria,
  // seção 11: a versão ATUAL já corrigiu o vazamento de access_token/
  // refresh_token em texto puro — não regredir isso nunca).
  { id: "ml-tokens", label: "Tokens ML", rota: "ml-tokens.html" },
  // Criação Anúncios ML era `adminOnly` em layout.js — mesma regra aqui.
  { id: "criar-anuncios-meli", label: "Criação Anúncios ML", rota: "criar-anuncios-meli.html" },
  // squads-config.html existe desde o PR #99 (backend + tela prontos) mas
  // nunca ganhou entrada no Shell V3 — hotfix pós-PR #99, achado 1.
  { id: "squads", label: "Squads", rota: "squads-config.html" },
  { id: "atividade", label: "Atividade", rota: "atividade.html" },
  { id: "control-center", label: "Control Center", rota: "control-center.html" },
  { id: "callbacks", label: "Callbacks", rota: "callbacks.html" },
  { id: "debug", label: "Debug Financeiro", rota: "financeiro-debug.html" },
  { id: "lab", label: "Laboratório UI", rota: "design-system-lab.html" },
];

/* ── Agrupamento visual (redesign do Shell V3, artboards aprovados) ──────
   Reorganização SOMENTE de apresentação: nenhum item sai de MODULOS/GLOBAIS/
   ADMIN acima, nenhuma rota muda, nenhum item é removido. GRUPOS_NAV só
   decide sob qual rótulo de seção cada `id` já existente aparece na
   sidebar. Administração continua fora daqui — colapsável e admin-only,
   como já era (nenhuma mudança pedida para ela). */
const TODOS_ITENS = [...MODULOS, ...GLOBAIS];
const IDS_MODULOS = new Set(MODULOS.map((m) => m.id));
function porId(id) {
  return TODOS_ITENS.find((m) => m.id === id) || null;
}
// Requer cliente+operação selecionados (era MODULOS) vs. sempre disponível
// (era GLOBAIS, cada tela tem seletor próprio) — a MESMA regra de antes,
// só que consultável por id em vez de decidida pela posição no array.
function requerContexto(id) {
  return IDS_MODULOS.has(id);
}

// Ícones da sidebar — família única (viewBox 24, stroke 2, cantos
// arredondados, sempre em currentColor = cor neutra do tema). Os itens do
// Mercado Livre seguem a linguagem visual do próprio ML (raio do Full, tag de
// anúncio, megafone do Mercado Ads), mas sem o verde/amarelo da marca: a
// sidebar continua neutra e só o item ativo ganha o roxo do produto.
// Só decorativo: item sem entrada aqui cai para a sigla (itemNav()).
const ICON_PESSOAS = '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M22 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path>';
const ICON_TAG = '<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"></path>';
const ICON_PULSO = '<path d="M22 12h-4l-3 9L9 3l-3 9H2"></path>';
const ICONS = {
  // Início — casa (antes era um gráfico, confundia com Financeiro/Relatórios)
  visao: '<path d="M3 10.5 12 3l9 7.5"></path><path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5"></path>',
  // Painel de Contas — quadro de cartões
  "painel-contas": '<rect x="3" y="3" width="7" height="9" rx="1.5"></rect><rect x="14" y="3" width="7" height="5" rx="1.5"></rect><rect x="14" y="12" width="7" height="9" rx="1.5"></rect><rect x="3" y="16" width="7" height="5" rx="1.5"></rect>',
  "cliente-360-v2": ICON_PESSOAS,
  "cliente-360-v3": '<circle cx="12" cy="8" r="4"></circle><path d="M4 21a8 8 0 0 1 16 0"></path>',
  "cliente-operacao": ICON_PESSOAS,
  "cliente-360": ICON_PESSOAS,
  // Central de Vendas — sacola (Vendas no painel do ML)
  "central-vendas": '<path d="M6 7h12l1 14H5L6 7z"></path><path d="M9 10V6a3 3 0 0 1 6 0v4"></path>',
  // Financeiro — carteira
  financeiro: '<path d="M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3"></path><path d="M3 7h16a2 2 0 0 1 2 2v3h-5a2 2 0 0 0 0 4h5"></path>',
  margem: '<line x1="19" y1="5" x2="5" y2="19"></line><circle cx="6.5" cy="6.5" r="2.5"></circle><circle cx="17.5" cy="17.5" r="2.5"></circle>',
  // Ads — megafone (Mercado Ads)
  ads: '<path d="M3 11v2a1 1 0 0 0 1 1h3l6 4V6L7 10H4a1 1 0 0 0-1 1z"></path><path d="M17 8.5a5 5 0 0 1 0 7"></path><path d="M19.5 6a8.5 8.5 0 0 1 0 12"></path>',
  // Anúncios — etiqueta (Anúncios do ML)
  anuncios: ICON_TAG + '<circle cx="8" cy="8" r="1.6"></circle>',
  // Central Full — o raio do Mercado Livre Full
  "central-full": '<path d="M13.5 2 5 13.2h6.2L9.8 22 19 10.3h-6.3L13.5 2z"></path>',
  // Curva ABC — barras em ordem decrescente
  "curva-abc": '<path d="M3 21h18"></path><rect x="4" y="5" width="4" height="16" rx="1"></rect><rect x="10" y="10" width="4" height="11" rx="1"></rect><rect x="16" y="15" width="4" height="6" rx="1"></rect>',
  // Automações — fluxo (gatilho → ação)
  automacoes: '<rect x="3" y="3" width="6" height="6" rx="1.5"></rect><rect x="15" y="15" width="6" height="6" rx="1.5"></rect><path d="M6 9v3a3 3 0 0 0 3 3h6"></path><path d="m12 12 3 3-3 3"></path>',
  diagnosticos: ICON_PULSO,
  "promocoes-ml": ICON_TAG + '<path d="m8 14 6-6"></path>',
  resgate: '<circle cx="12" cy="12" r="9"></circle><circle cx="12" cy="12" r="4"></circle><path d="m5.6 5.6 3.6 3.6"></path><path d="m14.8 14.8 3.6 3.6"></path><path d="m14.8 9.2 3.6-3.6"></path><path d="m5.6 18.4 3.6-3.6"></path>',
  pessoas: ICON_PESSOAS,
  // Clientes e Contas — maleta
  "clientes-contas": '<rect x="3" y="7" width="18" height="13" rx="2"></rect><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><path d="M3 13h18"></path>',
  // Relatórios — documento com linhas
  relatorios: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><path d="M14 3v6h6"></path><path d="M8 13h8"></path><path d="M8 17h5"></path>',
  sentinel: '<path d="M12 2l8 3v6c0 5-3.5 9-8 11-4.5-2-8-6-8-11V5z"></path><path d="M9 12l2 2 4-4"></path>',
  bases: '<ellipse cx="12" cy="5" rx="8" ry="3"></ellipse><path d="M20 12c0 1.66-3.6 3-8 3s-8-1.34-8-3"></path><path d="M4 5v14c0 1.66 3.6 3 8 3s8-1.34 8-3V5"></path>',
  ferramentas: '<path d="M14.7 6.3a4 4 0 1 0-5.4 5.4L2 19l3 3 7.3-7.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z"></path>',
  guia: '<path d="M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2z"></path><path d="M22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7z"></path>',
  "clientes-unificacao": '<circle cx="7" cy="7" r="3"></circle><circle cx="17" cy="7" r="3"></circle><path d="M7 10v2a5 5 0 0 0 10 0v-2"></path><path d="M12 17v4"></path>',
  "ml-tokens": '<circle cx="8" cy="15" r="4"></circle><path d="m10.8 12.2 8.7-8.7"></path><path d="m17 6 3 3"></path><path d="m14.5 8.5 2 2"></path>',
  "criar-anuncios-meli": ICON_TAG + '<path d="M9 9h6"></path><path d="M12 6v6"></path>',
  squads: ICON_PESSOAS,
  atividade: ICON_PULSO,
  "control-center": '<rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="m7 9 3 3-3 3"></path><path d="M13 15h4"></path>',
  callbacks: '<path d="M17 2l4 4-4 4"></path><path d="M3 11V9a3 3 0 0 1 3-3h15"></path><path d="M7 22l-4-4 4-4"></path><path d="M21 13v2a3 3 0 0 1-3 3H3"></path>',
  debug: '<rect x="7" y="7" width="10" height="13" rx="5"></rect><path d="M12 11v9"></path><path d="M3 13h4"></path><path d="M17 13h4"></path><path d="M9 4l1.5 3"></path><path d="M15 4l-1.5 3"></path>',
  lab: '<path d="M9 3h6"></path><path d="M10 3v6L4.5 19a1.5 1.5 0 0 0 1.3 2h12.4a1.5 1.5 0 0 0 1.3-2L14 9V3"></path><path d="M7 15h10"></path>',
};

// Ícones da moldura da sidebar (não são itens de navegação).
const UI_ICONS = {
  recolher: '<rect x="3" y="3" width="18" height="18" rx="3"></rect><path d="M9 3v18"></path><path d="m16 15-3-3 3-3"></path>',
  admin: '<path d="M12 2l8 3v6c0 5-3.5 9-8 11-4.5-2-8-6-8-11V5z"></path><circle cx="12" cy="11" r="2.5"></circle>',
  chevron: '<path d="m6 9 6 6 6-6"></path>',
  sair: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><path d="m16 17 5-5-5-5"></path><path d="M21 12H9"></path>',
};
function svgIcone(paths, cls, tam = 18) {
  return '<svg class="' + cls + '" width="' + tam + '" height="' + tam + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + "</svg>";
}

// Fora da sidebar para todos os perfis, mas ainda registradas em MODULOS/GLOBAIS
// (rota, gating e destaque continuam valendo) — acessíveis só por URL direta:
// Cliente 360 V1/V2/V3, Cliente Operação, Sentinel, Margem e Guia do Vendedor.
// Também fora (pedido da operação, 27/11/2026): Margem, Promoções ML, Resgate e
// Diagnósticos — continuam registradas e abrem por URL direta.
export const GRUPOS_NAV = [
  { titulo: "Operação", ids: ["visao", "painel-contas"] },
  { titulo: "Performance", ids: ["central-vendas", "financeiro", "ads", "anuncios", "central-full", "curva-abc"] },
  { titulo: "Execução", ids: ["automacoes", "ferramentas"] },
  { titulo: "Gestão", ids: ["pessoas", "clientes-contas", "relatorios", "bases"] },
];

// Navegação do ROLE global `admin`: o menu novo (GRUPOS_NAV) MAIS as ferramentas operacionais
// que saíram da sidebar de todos os perfis — Cliente 360 V3, Sentinel, Central de Vendas e
// Central de Margem. Mesmos ids/rotas/regras de contexto e marketplace de MODULOS/GLOBAIS
// (nenhum item novo é criado); só decide sob qual grupo cada id aparece. Os demais perfis
// continuam com GRUPOS_NAV exatamente como está. Não é mecanismo de segurança: a API autoriza.
// 27/11/2026: Central de Vendas voltou para todos (grupo Performance). Sentinel, Cliente 360 V3,
// Margem, Diagnósticos, Promoções ML e Resgate ficam só no dropdown Administração
// (IDS_NO_DROPDOWN_ADMIN) — o admin vê nos grupos o mesmo menu dos demais perfis.
export const GRUPOS_NAV_ADMIN = GRUPOS_NAV;
// Itens de MODULOS/GLOBAIS que o admin acessa pelo dropdown Administração, no topo dele,
// com as mesmas regras de contexto e marketplace que tinham nos grupos.
export const IDS_NO_DROPDOWN_ADMIN = ["cliente-360-v3", "sentinel", "margem", "diagnosticos", "promocoes-ml", "resgate"];
export function gruposNavPara(role) {
  return String(role || "").toLowerCase() === "admin" ? GRUPOS_NAV_ADMIN : GRUPOS_NAV;
}

export const MARKETPLACE_LABEL = { meli: "Mercado Livre", shopee: "Shopee", tiktok: "TikTok Shop" };

/* ── linkParams — recuperação de navegação (VENFORCE_AUDITORIA_FORENSE_
   RECUPERACAO_TELAS.md) ─────────────────────────────────────────────────
   Válvula de escape usada por buildHref() para módulos cuja página de
   destino NÃO fala o contrato padrão cliente/conta/periodo. Cada função só
   lê o campo que a página de destino documenta/realmente consome — nunca
   inventa parâmetro novo nem reaproveita um nome com outra semântica. */

// frontend-react/src/hooks/useCliente360.js:8-9 documenta o contrato:
// "cliente-360-react.html?slug=cliente-x&competencia=...". `marketplace`
// só vai junto quando o Shell já resolveu a operação (meta real, não
// GLOBAIS/ADMIN) — nunca um valor chutado.
function linkParamsCliente360V2(ctx, meta) {
  if (!ctx || !ctx.clienteSlug) return null;
  return { slug: ctx.clienteSlug, marketplace: meta && meta.marketplace ? meta.marketplace : undefined };
}

/* ── Estados (MASTER_SPEC §7.2) — tabela única; nenhuma lógica duplicada. */
const ESTADOS = {
  BOOT: { tom: "info", titulo: "Carregando…", texto: "Resolvendo a sua carteira." },
  PORTFOLIO_ERROR: {
    tom: "danger",
    titulo: "Não foi possível carregar a sua carteira",
    texto: "Isto é uma falha técnica, não uma carteira vazia.",
    acao: { label: "Tentar novamente", cmd: "retry" },
    alerta: true,
  },
  // O texto depende de o usuário TER squad: com SQUADS_ENFORCEMENT=OFF ele
  // pode legitimamente não ter nenhum, e o admin tem bypass sem membership.
  // Para os dois, "atribuído aos SEUS SQUADS" culpa um vínculo inexistente e
  // manda procurar um coordenador de squad que não há — ver textoNoPortfolio().
  NO_PORTFOLIO: {
    tom: "info",
    titulo: "Nenhum cliente atribuído aos seus squads",
    texto: "Fale com o coordenador do seu squad para receber acesso a uma carteira.",
  },
  NO_CLIENT: {
    tom: "info",
    titulo: "Selecione um cliente",
    // A Carteira saiu da navegação: o cliente e a operação se escolhem no
    // seletor da própria barra lateral, então o botão abre esse seletor.
    texto: "Este módulo trabalha dentro de uma operação. Escolha o cliente e a operação na barra lateral.",
    acao: { label: "Escolher cliente", cmd: "abrir-cliente" },
  },
  RESOLVING_CLIENT: { tom: "info", titulo: "Validando o cliente…", texto: "Conferindo se ele está na sua carteira." },
  INVALID_CLIENT: {
    tom: "warning",
    titulo: "Cliente indisponível",
    texto: "O cliente pedido não está disponível na sua carteira.",
    acao: { label: "Ir para o Painel de Contas", cmd: "painel-contas" },
  },
  FORBIDDEN: {
    tom: "danger",
    titulo: "Você não tem acesso a este cliente",
    texto: "O contexto foi descartado. Isto é uma falha de autorização — diferente de uma integração caída.",
    acao: { label: "Ir para o Painel de Contas", cmd: "painel-contas" },
    alerta: true,
  },
  RESOLVING_ACCOUNTS: { tom: "info", titulo: "Carregando operações…", texto: "Buscando as contas deste cliente." },
  NO_ACTIVE_ACCOUNT: {
    tom: "warning",
    titulo: "Este cliente ainda não tem operação configurada",
    texto: "Sem uma conta de marketplace ativa, os módulos operacionais não têm de onde ler.",
    acao: { label: "Configurar operação →", cmd: "clientes-contas" },
  },
  ACCOUNT_CHOICE_REQUIRED: {
    tom: "warning",
    titulo: "Escolha a operação",
    texto: "Este cliente tem mais de uma operação ativa. Nenhuma é escolhida automaticamente — é o que impede ler a loja errada.",
    acao: { label: "Escolher operação", cmd: "abrir-operacao" },
  },
  INVALID_ACCOUNT: {
    tom: "warning",
    titulo: "Operação inválida",
    texto: "A operação pedida não pertence a este cliente.",
    acao: { label: "Escolher operação", cmd: "abrir-operacao" },
  },
  ACCOUNT_INACTIVE: {
    tom: "warning",
    titulo: "Operação desativada",
    texto: "A operação que estava no contexto foi desativada. O cliente e a rota foram preservados.",
    acao: { label: "Escolher outra operação", cmd: "abrir-operacao" },
  },
  READY: null,
};

function el(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
}

function safeLocalStorage() {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

/* ── Adaptador padrão de API (real) para vf-context.init({ api }) ────────
   C1 (maratona Pessoa 1) — a carteira do shell passa a vir de
   GET /me/context (server/routes/meRoutes.js + services/meService.js), a
   fonte AUTORITATIVA por Squad prevista no MASTER_SPEC §18.2. Ela traz três
   coisas que o endpoint anterior não tinha: `squads`, `squadPrincipalId` e
   `contasAtivas` por cliente (o sub-rótulo "· N operações" do dropdown de
   Cliente existia no código e nunca aparecia, porque o payload antigo não
   tem esse campo).

   /operacao/cliente-360/clientes continua como QUEDA, e só para um caso: o
   servidor implantado ainda não conhece /me (404). Qualquer outra falha —
   500, rede, timeout — propaga como PORTFOLIO_ERROR, porque mascarar um 500
   atrás de um segundo endpoint esconderia um servidor doente atrás de uma
   carteira que "quase" funciona. Os dois resolvem a mesma carteira
   (resolvePortfolioClientes), então o fallback não muda quem o usuário vê,
   só empobrece o payload. Remoção: F6, depois de confirmado em produção. */
function createProductionContextApi(api) {
  const comoErro = (err) => ({ ok: false, code: err && err.code, erro: err && err.message });
  return {
    carteira: () =>
      api.get("/me/context").catch((err) => {
        if (err && err.status === 404) {
          return api.get("/operacao/cliente-360/clientes").catch(comoErro);
        }
        return comoErro(err);
      }),
    contasDoCliente: (ref, opts) =>
      api
        .get(`/clientes/${encodeURIComponent(ref)}/contas`, opts)
        .catch((err) => {
          if (err && err.name === "VfApiError" && err.status === 0 && err.code === "REDE") throw err; // deixa a rede real propagar (AbortError já é null)
          return comoErro(err);
        }),
  };
}

function readUser() {
  const storage = safeLocalStorage();
  try {
    const raw = storage ? storage.getItem(USER_KEY) : null;
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function hasToken() {
  const storage = safeLocalStorage();
  try {
    return !!(storage && storage.getItem(TOKEN_KEY));
  } catch {
    return false;
  }
}

/* ── Fabricação do DOM em volta do conteúdo existente (migração mínima) ──
   A página migrada NÃO ganha mount points novos no HTML — o shell constrói
   `.vf-shell` (MASTER_SPEC §16.3) e move o conteúdo atual para
   `.vf-shell__main`, sem alterar as classes internas dele. */
function buildShellDom() {
  if (document.querySelector(".vf-sidebar")) return null; // layout.js já montado — nunca junto (§5.3)
  const existing = document.querySelector(".vf-shell");
  if (existing) {
    return {
      root: existing,
      sidebar: existing.querySelector(".vf-shell__sidebar"),
      contextbar: existing.querySelector(".vf-shell__contextbar"),
      stateHost: existing.querySelector(".vf-shell__state"),
      main: existing.querySelector(".vf-shell__main"),
    };
  }

  const children = Array.from(document.body.childNodes);

  const root = el("div", "vf-shell");
  const sidebar = el("aside", "vf-shell__sidebar");
  sidebar.id = "vf-shell-sidebar";

  const bodyCol = el("div", "vf-shell__body");
  const contextbar = el("div", "vf-shell__contextbar");
  contextbar.id = "vf-shell-contextbar";
  contextbar.hidden = true;

  const stateHost = el("div", "vf-shell__state");
  stateHost.id = "vf-shell-state";
  stateHost.hidden = true;

  const main = el("main", "vf-shell__main");
  main.id = "vf-shell-main";
  children.forEach((node) => main.appendChild(node));

  bodyCol.appendChild(contextbar);
  bodyCol.appendChild(stateHost);
  bodyCol.appendChild(main);
  root.appendChild(sidebar);
  root.appendChild(bodyCol);
  document.body.appendChild(root);

  return { root, sidebar, contextbar, stateHost, main };
}

/* ── Fábrica testável (mesmo padrão de createVfApi/createVfContext) ──────
   Tudo que toca o mundo externo (DOM, matchMedia, localStorage) é
   injetável para o teste headless (S01–S13) poder controlar o ambiente. */
export function createVfShell(options = {}) {
  const win = options.window || (typeof window !== "undefined" ? window : null);
  const doc = options.document || (typeof document !== "undefined" ? document : null);
  if (!doc) throw new Error("vf-shell.js requer um DOM (document).");

  const ctxStore = options.context || vfContext;
  const onNavigate = options.onNavigate || ((href) => { if (win) win.location.href = href; });
  const onCommand = options.onCommand || defaultCommand;
  const getUser = options.getUser || readUser;
  const storage = options.storage || safeLocalStorage();
  let unificacaoUiEnabled = options.unificacaoUiEnabled === true;

  const dom = options.dom || buildShellDom();
  if (!dom) return null; // abortou: .vf-sidebar (layout.js) já presente

  const host = dom.sidebar;
  const main = dom.main;
  const stateHost = dom.stateHost;
  const contextbar = dom.contextbar;

  // aria-live="polite" que anuncia a troca de contexto (§9.3) — não existe
  // no resto da página, então o shell é quem precisa garantir um só.
  let announcer = dom.root.querySelector("#vf-shell-announcer");
  if (!announcer) {
    announcer = el("div", "vf-visually-hidden");
    announcer.id = "vf-shell-announcer";
    announcer.setAttribute("aria-live", "polite");
    announcer.setAttribute("role", "status");
    dom.root.appendChild(announcer);
  }
  let ultimoAnuncio = null;

  let dropdownAberto = null; // "cliente" | "operacao" | null
  let colapsada = false;
  try {
    colapsada = storage ? storage.getItem(COLLAPSE_KEY) === "1" : false;
  } catch {
    /* preferência de UI — falha aqui não impede o shell de renderizar */
  }

  function defaultCommand(cmd) {
    if (cmd === "logout") doLogout();
    if (cmd === "retry" && win) win.location.reload();
  }

  function doLogout() {
    ctxStore.clearOperationalContext(); // D12 — logout limpa o contexto operacional
    try {
      storage && storage.removeItem(TOKEN_KEY);
      storage && storage.removeItem(USER_KEY);
    } catch {
      /* ignora — o redirect ainda acontece */
    }
    onNavigate("index.html");
  }

  function mq(query) {
    return !!(win && typeof win.matchMedia === "function" && win.matchMedia(query).matches);
  }

  /* DOIS predicados, não um (§19.1) — ver MASTER_SPEC para a distinção. */
  function contextoNaBarra() {
    return mq("(max-width: 1200px)");
  }
  function railEstreito() {
    return mq("(min-width: 861px) and (max-width: 1200px)");
  }

  /* ── Recolher/expandir ───────────────────────────────────────────────────
     A largura da coluna anima (grid-template-columns em .vf-shell) só no
     clique do botão — `is-sidebar-animating` liga a transição por ~meio
     segundo. Carregar a página já recolhida não anima nada. */
  let transicao = null; // "expanding" | "collapsing" | null
  let timerTransicao = null;
  let adminAberto = false;

  function alternarColapso(valor) {
    if (valor === colapsada) return;
    colapsada = valor;
    try {
      storage && storage.setItem(COLLAPSE_KEY, colapsada ? "1" : "0");
    } catch {
      /* preferência de UI — segue sem persistir */
    }
    transicao = colapsada ? "collapsing" : "expanding";
    if (dom.root && dom.root.classList) dom.root.classList.add("is-sidebar-animating");
    clearTimeout(timerTransicao);
    timerTransicao = setTimeout(() => {
      transicao = null;
      if (dom.root && dom.root.classList) dom.root.classList.remove("is-sidebar-animating");
      if (host) host.classList.remove("is-collapsing", "is-expanding");
    }, 650);
    render(ctxStore.getSnapshot());
  }

  // Rail = só ícones: recolhida pelo usuário (≥861px) ou forçada pela faixa
  // 861–1200. Abaixo de 860 a sidebar vira faixa horizontal com rótulos.
  function emRail() {
    return railEstreito() || (colapsada && !mq("(max-width: 860px)"));
  }

  /* Dica flutuante do rail — um nó só, em <body>, posição fixa: a sidebar
     tem overflow:hidden e cortaria um tooltip feito com ::after. */
  let dica = null;
  function esconderDica() {
    if (dica) dica.classList.remove("is-visible");
  }
  function mostrarDica(alvo) {
    if (!host || !host.classList.contains("is-rail") || !doc.body) return;
    const texto = alvo.dataset.tip;
    if (!texto) return;
    if (!dica) {
      dica = el("div", "vf-shell__tip");
      dica.setAttribute("role", "tooltip");
      dica.setAttribute("aria-hidden", "true");
      doc.body.appendChild(dica);
    }
    dica.textContent = texto;
    const r = alvo.getBoundingClientRect();
    const hr = host.getBoundingClientRect();
    dica.style.left = `${Math.round(hr.right + 10)}px`;
    dica.style.top = `${Math.round(r.top + r.height / 2)}px`;
    dica.classList.toggle("is-disabled", alvo.getAttribute("aria-disabled") === "true");
    dica.classList.add("is-visible");
  }
  if (host && typeof host.addEventListener === "function") {
    const alvoDica = (e) => (e.target && typeof e.target.closest === "function" ? e.target.closest("[data-tip]") : null);
    host.addEventListener("mouseover", (e) => {
      const alvo = alvoDica(e);
      if (alvo) mostrarDica(alvo);
      else esconderDica();
    });
    host.addEventListener("mouseleave", esconderDica);
    host.addEventListener("focusin", (e) => {
      const alvo = alvoDica(e);
      if (alvo) mostrarDica(alvo);
    });
    host.addEventListener("focusout", esconderDica);
    host.addEventListener("scroll", esconderDica, { passive: true });
  }

  function abreviar(label) {
    const p = String(label).split(/\s+/);
    if (p.length > 1) return (p[0][0] + p[p.length - 1][0]).toUpperCase();
    return label.slice(0, 2);
  }

  function moduloDisponivel(mod, meta) {
    if (!mod.marketplaces) return true;
    if (!meta) return true; // sem contexto: não pré-julga (§14.2)
    return mod.marketplaces.indexOf(meta.marketplace) >= 0;
  }

  function motivoIndisponivel(mod, meta) {
    const mkt = MARKETPLACE_LABEL[meta.marketplace] || meta.marketplace;
    return `${mod.label} — indisponível para operações ${mkt}`;
  }

  /* ── Render ──────────────────────────────────────────────────────────── */

  function render(snap) {
    if (!host) return;
    const estado = snap.state;
    const ctx = snap.context;
    const meta = snap.meta;
    const user = getUser();
    const carregando = estado === "BOOT" || estado === "RESOLVING_CLIENT" || estado === "RESOLVING_ACCOUNTS";

    host.innerHTML = "";
    esconderDica();
    const rail = emRail();
    host.className =
      "vf-shell__sidebar" +
      (colapsada ? " is-collapsed" : "") +
      (rail ? " is-rail" : "") +
      (transicao ? ` is-${transicao}` : "");
    if (dom.root && dom.root.classList) dom.root.classList.toggle("is-sidebar-collapsed", colapsada);
    let ordem = 0; // índice de cada item, para o escalonamento da animação de entrada (--i)

    const logo = el("div", "vf-shell__logo");
    logo.innerHTML =
      '<span class="vf-shell__brand"><span class="vf-shell__brand-mark">VF</span>' +
      '<span class="vf-shell__brand-text">Venforce</span></span>';
    const toggle = el("button", "vf-shell__collapse");
    toggle.type = "button";
    toggle.innerHTML = svgIcone(UI_ICONS.recolher, "vf-shell__collapse-icon", 18);
    toggle.setAttribute("aria-label", colapsada ? "Expandir menu" : "Recolher menu");
    toggle.setAttribute("aria-expanded", colapsada ? "false" : "true");
    toggle.dataset.tip = colapsada ? "Expandir menu" : "Recolher menu";
    toggle.addEventListener("click", () => alternarColapso(!colapsada));
    logo.appendChild(toggle);
    host.appendChild(logo);

    // Recolhida: o bloco de contexto (2 cards altos) não cabe no rail — vira
    // um botão compacto com as iniciais do cliente. Clicar expande o menu e
    // já abre a escolha de cliente. Na faixa ≤1200 o contexto mora na barra
    // superior (contextoNaBarra), então o atalho não faz falta ali.
    if (colapsada && !contextoNaBarra()) {
      const clienteAtual = ctxStore.getClienteAtual();
      const mini = el("button", "vf-shell__context-mini" + (meta ? ` is-${meta.status.tone}` : ""));
      mini.type = "button";
      mini.innerHTML =
        `<span class="vf-shell__context-mini-initials">${fmt.escapeHTML(clienteAtual ? fmt.iniciais(clienteAtual.nome) : "?")}</span>` +
        '<span class="vf-shell__context-mini-dot" aria-hidden="true"></span>';
      const rotuloMini = clienteAtual
        ? `${clienteAtual.nome}${meta ? " · " + meta.nome : ""} — trocar`
        : "Escolher cliente";
      mini.setAttribute("aria-label", rotuloMini);
      mini.dataset.tip = rotuloMini;
      mini.addEventListener("click", () => {
        alternarColapso(false);
        abrirDropdown("cliente");
      });
      host.appendChild(mini);
    }

    const bloco = blocoContexto(estado, ctx, meta, carregando, snap);
    if (contextoNaBarra() && contextbar) {
      contextbar.hidden = false;
      contextbar.innerHTML = "";
      contextbar.appendChild(bloco);
    } else {
      if (contextbar) {
        contextbar.hidden = true;
        contextbar.innerHTML = "";
      }
      host.appendChild(bloco);
    }

    // Redesign do Shell V3 (artboards aprovados) — os mesmos MODULOS/GLOBAIS
    // de sempre, só reagrupados sob os rótulos visuais aprovados. Cada item
    // mantém EXATAMENTE a regra de disponibilidade que já tinha (contexto
    // obrigatório + gating por marketplace para quem era MODULOS; sempre
    // disponível para quem era GLOBAIS) — só decidida por id agora.
    gruposNavPara(user.role).forEach((grupo) => {
      const papelAtual = String(user.role || "").toLowerCase();
      const itens = grupo.ids.map(porId).filter(Boolean).filter((mod) => !mod.papeis || mod.papeis.includes(papelAtual));
      const disponiveis = [];
      const indisponiveis = [];
      itens.forEach((mod) => {
        if (requerContexto(mod.id) && meta && !moduloDisponivel(mod, meta)) {
          indisponiveis.push(mod);
        } else {
          disponiveis.push(mod);
        }
      });

      const rotuloGrupo = el("div", "vf-shell__section-label");
      rotuloGrupo.innerHTML = `<span>${fmt.escapeHTML(grupo.titulo)}</span>`;
      host.appendChild(rotuloGrupo);
      const nav = el("nav", "vf-shell__nav");
      nav.setAttribute("aria-label", grupo.titulo);
      disponiveis.forEach((mod) => {
        const motivo = requerContexto(mod.id) && estado !== "READY" ? "Escolha um cliente e uma operação para abrir este módulo" : null;
        const item = itemNav(mod, motivo, meta);
        item.style.setProperty("--i", String(ordem++));
        nav.appendChild(item);
      });

      if (indisponiveis.length >= 3) {
        const mkt = MARKETPLACE_LABEL[meta.marketplace] || meta.marketplace;
        const det = el("details", "vf-shell__unavailable");
        det.innerHTML = `<summary>Indisponíveis para ${fmt.escapeHTML(mkt)} (${indisponiveis.length})</summary>`;
        indisponiveis.forEach((mod) => det.appendChild(itemNav(mod, motivoIndisponivel(mod, meta), meta)));
        nav.appendChild(det);
      } else {
        indisponiveis.forEach((mod) => nav.appendChild(itemNav(mod, motivoIndisponivel(mod, meta), meta)));
      }
      host.appendChild(nav);
    });

    if (String(user.role || "").toLowerCase() === "admin") {
      const admin = el("details", "vf-shell__admin");
      const extrasAdmin = IDS_NO_DROPDOWN_ADMIN.map(porId).filter(Boolean);
      const itensAdmin = [...extrasAdmin, ...ADMIN.filter((mod) => !mod.unificacaoUi || unificacaoUiEnabled)];
      // Aberto se o usuário deixou aberto, ou se a página atual é uma delas
      // (antes fechava a cada re-render e escondia o item ativo).
      if (adminAberto || itensAdmin.some((mod) => mod.id === doc.body.dataset.vfModule)) admin.open = true;
      admin.innerHTML =
        '<summary data-tip="Administração">' +
        svgIcone(UI_ICONS.admin, "vf-shell__item-icon") +
        '<span class="vf-shell__item-label">Administração</span>' +
        svgIcone(UI_ICONS.chevron, "vf-shell__admin-chevron", 14) +
        "</summary>";
      admin.addEventListener("toggle", () => {
        adminAberto = admin.open;
      });
      const navA = el("nav", "vf-shell__nav");
      itensAdmin.forEach((mod, i) => {
        let item;
        if (extrasAdmin.includes(mod)) {
          let motivo = null;
          if (requerContexto(mod.id) && estado !== "READY") motivo = "Escolha um cliente e uma operação para abrir este módulo";
          else if (requerContexto(mod.id) && meta && !moduloDisponivel(mod, meta)) motivo = motivoIndisponivel(mod, meta);
          item = itemNav(mod, motivo, meta);
        } else {
          item = itemNav(mod, null, null);
        }
        item.style.setProperty("--j", String(i));
        navA.appendChild(item);
      });
      admin.appendChild(navA);
      host.appendChild(admin);
    }

    const footer = el("div", "vf-shell__footer");
    const nomeUsuario = user.nome || "Usuário";
    footer.innerHTML =
      `<span class="vf-shell__avatar" data-tip="${fmt.escapeHTML(nomeUsuario)}">${fmt.escapeHTML(fmt.iniciais(user.nome))}</span>` +
      `<span class="vf-shell__user"><b>${fmt.escapeHTML(nomeUsuario)}</b>` +
      `<small>${fmt.escapeHTML(String(user.role || "").toLowerCase() === "admin" ? "Administrador" : "Usuário")}</small></span>`;
    const sair = el("button", "vf-shell__logout");
    sair.innerHTML = svgIcone(UI_ICONS.sair, "vf-shell__logout-icon", 16);
    sair.type = "button";
    sair.dataset.tip = "Sair";
    sair.setAttribute("aria-label", "Sair");
    sair.addEventListener("click", () => onCommand("logout"));
    footer.appendChild(sair);
    host.appendChild(footer);

    aplicarGating(snap);

    // Anuncia só quando cliente+conta MUDA de verdade — um resize ou um
    // re-render por outro motivo não pode repetir o mesmo anúncio (§9.3).
    if (estado === "READY" && ctx) {
      const chave = `${ctx.clienteId}:${ctx.clienteContaId}`;
      if (chave !== ultimoAnuncio) {
        ultimoAnuncio = chave;
        const clienteAtual = ctxStore.getClienteAtual();
        const nomeCliente = clienteAtual ? clienteAtual.nome : "";
        const nomeConta = meta ? meta.nome : "";
        announcer.textContent = `Contexto: ${nomeCliente}, ${nomeConta}`;
      }
    } else if (!ctx) {
      ultimoAnuncio = null;
    }
  }

  function itemNav(mod, motivoDesabilitado, meta) {
    const futuro = !!mod.futuro || !mod.rota;
    const desabilitado = motivoDesabilitado || futuro;
    const isActive = doc.body.dataset.vfModule === mod.id;
    const a = el("a", "vf-shell__item" + (isActive ? " is-active" : "") + (desabilitado ? " is-disabled" : ""));
    a.href = desabilitado ? "#" : buildHref(mod, meta);
    // Ícone + rótulo SEMPRE no DOM — o CSS decide o que aparece. Recolher/
    // expandir passa a ser só troca de classe (o rótulo some com fade e o
    // ícone não sai do lugar), em vez de trocar o item por uma sigla ("In",
    // "PC", "Se"…) que ninguém conseguia ler. Sigla só para item sem ícone.
    const icone = ICONS[mod.id];
    a.innerHTML =
      (icone
        ? svgIcone(icone, "vf-shell__item-icon")
        : `<span class="vf-shell__item-abbr" aria-hidden="true">${fmt.escapeHTML(abreviar(mod.label))}</span>`) +
      `<span class="vf-shell__item-label">${fmt.escapeHTML(mod.label)}</span>`;
    a.dataset.tip = motivoDesabilitado || (futuro ? `${mod.label} — ainda não disponível nesta versão` : mod.label);
    if (emRail()) a.setAttribute("aria-label", mod.label);
    a.dataset.module = mod.id;
    if (isActive) a.setAttribute("aria-current", "page");
    if (desabilitado) {
      // aria-disabled + title, NUNCA `disabled` puro (§9.3) — alcançável por
      // teclado, motivo legível.
      a.setAttribute("aria-disabled", "true");
      a.title = motivoDesabilitado || "Ainda não disponível nesta versão";
      a.addEventListener("click", (e) => e.preventDefault());
    } else {
      // O href acima é um retrato do momento do render; o `periodo` pode
      // mudar DEPOIS dele sem passar pelo store — as ilhas React escrevem
      // `?periodo=` direto na URL (frontend-react/src/utils/periodoUrl.js) e
      // não têm como notificar o shell. Recalcular no clique é o único jeito
      // de o destino refletir a competência que está na tela agora.
      //
      // Só o clique principal: ctrl/cmd/shift/meio abrem em outra aba e ali
      // vale o href renderizado, que continua correto para copiar o link.
      a.addEventListener("click", (e) => {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        onNavigate(buildHref(mod, meta));
      });
    }
    return a;
  }

  // Convergência #4 §15 — resolve a rota de um módulo pelo marketplace da
  // conta em tela. `rotaPorMarketplace` é opcional e aditivo: um módulo sem
  // ele (todo mundo, exceto `financeiro`) continua resolvendo `mod.rota`
  // direto, sempre. Sem meta/marketplace resolvido, ou marketplace fora do
  // mapa (TikTok legado), cai em `mod.rota` — nunca fica sem destino algum
  // (§17: TikTok precisa manter um caminho funcional).
  function resolverRota(mod, meta) {
    if (mod.rotaPorMarketplace && meta && meta.marketplace && mod.rotaPorMarketplace[meta.marketplace]) {
      return mod.rotaPorMarketplace[meta.marketplace];
    }
    return mod.rota;
  }

  // Links normais entre os dois mundos (§20.1): a página migrada passa
  // ?cliente=&conta= para a que ainda não migrou; ela ignora o que não
  // entende e usa o próprio seletor. Nenhuma quebra.
  //
  // `periodo` viaja junto (§8.5: "preservado ao trocar módulo/conta,
  // resetado ao trocar cliente"). Faltava aqui: quem estava olhando julho na
  // Visão e clicava em Financeiro chegava em outro mês, sem nada indicar a
  // troca. Trocar de CLIENTE continua zerando o período — setCliente() limpa
  // o parâmetro antes de qualquer navegação, então não há o que propagar.
  function buildHref(mod, meta) {
    const rota = resolverRota(mod, meta);
    const ctx = ctxStore.getContext();
    // `linkParams` é a válvula de escape para páginas que NÃO falam o
    // contrato padrão cliente/conta/periodo (recuperação de navegação —
    // ver linkParamsCliente360V2). Nunca inventa
    // parâmetro: cada função só lê o campo que a página de destino
    // realmente documenta ler.
    if (mod.linkParams) {
      const params = mod.linkParams(ctx, meta) || {};
      const qs = new URLSearchParams();
      Object.keys(params).forEach((chave) => {
        const valor = params[chave];
        if (valor !== null && valor !== undefined && valor !== "") qs.set(chave, String(valor));
      });
      const s = qs.toString();
      return s ? `${rota}?${s}` : rota;
    }
    if (!ctx || !ctx.clienteSlug) return rota;
    const qs = new URLSearchParams();
    qs.set("cliente", ctx.clienteSlug);
    if (ctx.clienteContaId) qs.set("conta", String(ctx.clienteContaId));
    const periodo = ctxStore.getPeriodoParam ? ctxStore.getPeriodoParam() : null;
    if (periodo) qs.set("periodo", periodo);
    return `${rota}?${qs.toString()}`;
  }

  function blocoContexto(estado, ctx, meta, carregando, snap) {
    const escopoPagina = doc.body.dataset.vfScope || "global";
    const bloco = el("div", "vf-shell__context" + (escopoPagina === "global" ? " is-muted" : ""));
    const cliente = ctxStore.getClienteAtual();

    const rotuloEscopo = escopoPagina === "global" ? '<span class="vf-shell__context-flag">contexto ativo</span>' : "";

    // Redesign do Shell V3 (artboards aprovados) — o rótulo ("Cliente
    // atual"/"Operação") passa a viver DENTRO do próprio card do seletor,
    // como primeira linha (§ "cards de contexto"). `.vf-ctx-selector`
    // continua sendo filho DIRETO de `.vf-shell__context` — nenhuma div
    // nova entra entre os dois, então o modo `contextbar` (§19.1, Bug B já
    // corrigido) não muda de comportamento: só o conteúdo do botão mudou.
    const btnC = el("button", "vf-ctx-selector" + (dropdownAberto === "cliente" ? " is-open" : ""));
    btnC.type = "button";
    btnC.id = "vf-cliente-trigger";
    btnC.setAttribute("aria-haspopup", "listbox");
    btnC.setAttribute("aria-expanded", dropdownAberto === "cliente" ? "true" : "false");
    const rotuloCliente = `<span class="vf-ctx-selector__label">Cliente atual${rotuloEscopo}</span>`;
    if (carregando && !cliente) {
      btnC.innerHTML = rotuloCliente + '<span class="vf-skeleton vf-skeleton--row" style="width:100%;height:14px"></span>';
      btnC.disabled = true;
    } else {
      btnC.innerHTML =
        rotuloCliente +
        `<span class="vf-ctx-selector__value${cliente ? "" : " is-empty"}">` +
        fmt.escapeHTML(cliente ? cliente.nome : "Selecione um cliente") +
        '</span><span aria-hidden="true">▾</span>';
    }
    btnC.addEventListener("click", () => abrirDropdown(dropdownAberto === "cliente" ? null : "cliente"));
    bloco.appendChild(btnC);
    if (dropdownAberto === "cliente") bloco.appendChild(dropdownClientes());

    const contas = ctxStore.getAccounts().filter((c) => c.ativo !== false);
    const btnO = el("button", "vf-ctx-selector" + (dropdownAberto === "operacao" ? " is-open" : ""));
    btnO.type = "button";
    btnO.id = "vf-op-trigger";
    btnO.setAttribute("aria-haspopup", "listbox");
    btnO.setAttribute("aria-expanded", dropdownAberto === "operacao" ? "true" : "false");
    const rotuloOperacao = '<span class="vf-ctx-selector__label">Operação</span>';

    if (estado === "RESOLVING_ACCOUNTS") {
      btnO.innerHTML = rotuloOperacao + '<span class="vf-skeleton vf-skeleton--row" style="width:100%;height:14px"></span>';
      btnO.disabled = true;
    } else if (!cliente) {
      btnO.innerHTML = rotuloOperacao + '<span class="vf-ctx-selector__value is-empty">—</span>';
      btnO.disabled = true;
    } else if (!contas.length) {
      btnO.innerHTML = rotuloOperacao + '<span class="vf-ctx-selector__value is-empty">Sem operação</span>';
      btnO.disabled = true; // visível e desabilitado, nunca escondido (§9.2)
    } else if (meta) {
      // Regra do redesign: sem grant conectado, o identificador operacional
      // ainda não existe — não inventamos um (§ "regra visual do ID"). Com
      // grant, mostra normalmente (comportamento de antes, inalterado).
      const semGrant = meta.status.code === "sem_grant";
      btnO.innerHTML =
        rotuloOperacao +
        `<span class="vf-ctx-selector__value"><span class="vf-status is-${meta.status.tone}">` +
        '<span aria-hidden="true"></span></span>' +
        fmt.escapeHTML(meta.nome) +
        '</span><span aria-hidden="true">▾</span>' +
        (semGrant
          ? `<small class="vf-ctx-selector__sub">${fmt.escapeHTML(meta.status.label)}</small>`
          : `<small class="vf-ctx-selector__sub">${fmt.escapeHTML(meta.externalAccountLabel)}</small>`);
      btnO.disabled = contas.length === 1; // 1 ativa: nada a escolher (precedente fechamentos-api.js:820)
    } else {
      btnO.innerHTML = rotuloOperacao + '<span class="vf-ctx-selector__value is-empty">Selecione a operação…</span><span aria-hidden="true">▾</span>';
    }
    btnO.addEventListener("click", () => abrirDropdown(dropdownAberto === "operacao" ? null : "operacao"));
    bloco.appendChild(btnO);
    if (dropdownAberto === "operacao") bloco.appendChild(dropdownOperacoes());

    if (meta) {
      const integ = snap.integration || {};
      const linhas = [];
      if (meta.marketplace === "meli" && integ.grant && integ.grant !== "conectado") {
        linhas.push('<span class="vf-shell__integ is-warning">⚠ Mercado Livre desconectado</span>');
      }
      linhas.push(
        meta.base
          ? `<span class="vf-shell__integ">Base: ${fmt.escapeHTML(meta.base.nome)}</span>`
          : '<span class="vf-shell__integ is-warning">⚠ sem base vinculada</span>'
      );
      bloco.appendChild(el("div", "vf-shell__integrations", linhas.join("")));
    }

    return bloco;
  }

  function dropdownClientes() {
    const lista = ctxStore.getPortfolio();
    const box = el("div", "vf-menu vf-shell__dropdown");
    box.setAttribute("role", "listbox");
    box.setAttribute("aria-label", "Clientes da carteira");

    if (lista.length >= 8) {
      const wrap = el("div", "vf-shell__dropdown-search");
      const input = el("input", "vf-input vf-input--sm");
      input.type = "search";
      input.placeholder = "Buscar cliente…";
      input.setAttribute("aria-label", "Buscar cliente");
      input.addEventListener("input", () => {
        const q = fmt.normalizarBusca(input.value);
        Array.prototype.forEach.call(box.querySelectorAll(".vf-menu__item"), (it) => {
          it.hidden = q ? fmt.normalizarBusca(it.dataset.busca).indexOf(q) < 0 : false;
        });
      });
      wrap.appendChild(input);
      box.appendChild(wrap);
      setTimeout(() => input.focus(), 0);
    }

    const atual = ctxStore.getContext();
    lista.forEach((c) => {
      const it = el("button", "vf-menu__item");
      it.type = "button";
      it.setAttribute("role", "option");
      it.dataset.busca = `${c.nome} ${c.slug}`;
      const selecionado = atual && atual.clienteId === c.id;
      it.setAttribute("aria-selected", selecionado ? "true" : "false");
      const subOperacoes = typeof c.contasAtivas === "number" ? ` · ${c.contasAtivas} operaç${c.contasAtivas === 1 ? "ão" : "ões"}` : "";
      it.innerHTML =
        fmt.escapeHTML(c.nome) +
        (selecionado ? ' <span class="vf-menu__check" aria-hidden="true">✓</span>' : "") +
        `<small>${fmt.escapeHTML(c.slug)}${subOperacoes}</small>`;
      it.addEventListener("click", () => {
        abrirDropdown(null);
        ctxStore.setCliente(c.slug); // I1 — zera conta, revalida cardinalidade
      });
      box.appendChild(it);
    });
    wireTeclado(box);
    return box;
  }

  function dropdownOperacoes() {
    const contas = ctxStore.getAccounts();
    const cliente = ctxStore.getClienteAtual();
    const atual = ctxStore.getContext();
    const box = el("div", "vf-menu vf-shell__dropdown");
    box.setAttribute("role", "listbox");
    box.setAttribute("aria-label", `Operações de ${cliente ? cliente.nome : ""}`);
    box.appendChild(el("div", "vf-menu__label", `Operações de ${fmt.escapeHTML(cliente ? cliente.nome : "")}`));

    contas.forEach((c) => {
      const st = statusOperacao(c);
      const inativa = c.ativo === false;
      const it = el("button", "vf-menu__item" + (inativa ? " is-disabled" : ""));
      it.type = "button";
      it.setAttribute("role", "option");
      const sel = atual && atual.clienteContaId === c.id;
      it.setAttribute("aria-selected", sel ? "true" : "false");
      if (inativa) it.setAttribute("aria-disabled", "true");
      // Regra do redesign: sem grant, o identificador operacional ainda não
      // existe — a sub-linha mostra só o rótulo de estado, nunca um ID
      // inventado (mesma regra aplicada ao gatilho fechado, blocoContexto()).
      const semGrant = st.code === "sem_grant";
      it.innerHTML =
        `<span class="vf-status is-${st.tone}"><span aria-hidden="true"></span>` +
        `<span class="vf-visually-hidden">${fmt.escapeHTML(st.label)}</span></span>` +
        fmt.escapeHTML(c.nome) +
        (inativa ? " (inativa)" : "") +
        (sel ? ' <span class="vf-menu__check" aria-hidden="true">✓</span>' : "") +
        (semGrant
          ? `<small>${fmt.escapeHTML(st.label)}</small>`
          : `<small>${fmt.escapeHTML(rotuloExterno(c))} · ${fmt.escapeHTML(st.label)}</small>`);
      if (!inativa) {
        it.addEventListener("click", () => {
          abrirDropdown(null);
          ctxStore.setConta(c.id); // troca de operação MANTÉM a rota (§9, fluxo 6)
        });
      }
      box.appendChild(it);
    });

    const ger = el("button", "vf-menu__item vf-menu__item--footer");
    ger.type = "button";
    ger.textContent = "Gerenciar operações →";
    ger.addEventListener("click", () => {
      abrirDropdown(null);
      onNavigate("clientes.html");
    });
    box.appendChild(ger);
    wireTeclado(box);
    return box;
  }

  function wireTeclado(box) {
    box.addEventListener("keydown", (e) => {
      const itens = Array.prototype.filter.call(box.querySelectorAll(".vf-menu__item"), (i) => !i.hidden);
      const i = itens.indexOf(doc.activeElement);
      if (e.key === "ArrowDown") {
        e.preventDefault();
        (itens[i + 1] || itens[0])?.focus();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        (itens[i - 1] || itens[itens.length - 1])?.focus();
      } else if (e.key === "Home") {
        e.preventDefault();
        itens[0]?.focus();
      } else if (e.key === "End") {
        e.preventDefault();
        itens[itens.length - 1]?.focus();
      } else if (e.key === "Escape") {
        e.preventDefault();
        const gatilhoId = dropdownAberto === "operacao" ? "vf-op-trigger" : dropdownAberto === "cliente" ? "vf-cliente-trigger" : null;
        abrirDropdown(null);
        if (gatilhoId) doc.getElementById(gatilhoId)?.focus(); // Esc devolve o foco ao gatilho (§9.3)
      }
    });
  }

  function abrirDropdown(qual) {
    dropdownAberto = qual;
    render(ctxStore.getSnapshot());
    if (qual) {
      const primeiro = host.querySelector(".vf-shell__dropdown .vf-menu__item:not(.is-disabled)");
      if (primeiro) setTimeout(() => primeiro.focus(), 0);
    }
  }

  /* ── Gating por escopo (MASTER_SPEC §5.4) ────────────────────────────── */

  /* Carteira vazia continua sendo ESTADO (nunca erro — M12 já separa os
     dois); o que muda é a EXPLICAÇÃO. Só quem tem squad pode ser mandado ao
     coordenador do squad dele. `getSquads()` vem de /me/context e é `[]`
     tanto para quem ainda não foi mapeado (enforcement OFF) quanto para o
     admin, que enxerga por bypass e não precisa ser membro de nada. */
  function textoNoPortfolio() {
    const squads = ctxStore.getSquads ? ctxStore.getSquads() : [];
    if (squads && squads.length) return null;
    return {
      titulo: "Nenhum cliente na sua carteira",
      texto: "Fale com o seu coordenador para receber acesso a uma carteira.",
    };
  }

  function aplicarGating(snap) {
    const escopo = doc.body.dataset.vfScope || "global";
    const estado = snap.state;

    const satisfeito =
      escopo === "global"
        ? estado !== "BOOT" && estado !== "PORTFOLIO_ERROR"
        : escopo === "client"
        ? !!(snap.context && snap.context.clienteId)
        : estado === "READY"; // "account"

    doc.body.classList.toggle("vf-shell-blocked", !satisfeito);
    if (main) main.hidden = !satisfeito;
    if (!stateHost) return;

    if (satisfeito) {
      stateHost.innerHTML = "";
      stateHost.hidden = true;
      return;
    }

    let def = ESTADOS[estado];
    if (!def) {
      stateHost.innerHTML = "";
      stateHost.hidden = true;
      return;
    }
    if (estado === "NO_PORTFOLIO") def = Object.assign({}, def, textoNoPortfolio());

    stateHost.hidden = false;
    const acao = def.acao
      ? `<div class="vf-banner__actions"><button type="button" class="vf-btn vf-btn--primary vf-btn--sm" data-cmd="${def.acao.cmd}">${fmt.escapeHTML(def.acao.label)}</button></div>`
      : "";
    const detalhe = snap.error && snap.error.mensagem ? `<p class="vf-banner__description"><small>${fmt.escapeHTML(snap.error.mensagem)}</small></p>` : "";

    stateHost.innerHTML =
      `<div class="vf-banner is-${def.tom}" role="${def.alerta ? "alert" : "status"}">` +
      '<div class="vf-banner__content">' +
      `<p class="vf-banner__title">${fmt.escapeHTML(def.titulo)}</p>` +
      `<p class="vf-banner__description">${fmt.escapeHTML(def.texto)}</p>${detalhe}` +
      `</div>${acao}</div>` +
      `<p class="vf-state-machine">estado do contexto: <code>${fmt.escapeHTML(estado)}</code></p>`;

    const btn = stateHost.querySelector("[data-cmd]");
    if (btn) {
      btn.addEventListener("click", () => {
        const cmd = btn.dataset.cmd;
        if (cmd === "painel-contas") onNavigate("painel-contas.html");
        else if (cmd === "clientes-contas") onNavigate("clientes.html");
        else if (cmd === "abrir-cliente") abrirDropdown("cliente");
        else if (cmd === "abrir-operacao") abrirDropdown("operacao");
        else onCommand(cmd);
      });
    }
  }

  /* Cruzar qualquer uma das duas faixas muda a montagem — precisa de
     re-render. Redimensionar DENTRO da mesma faixa não redesenha nada. */
  let timerResize = null;
  let faixaAnterior = `${contextoNaBarra()}${railEstreito()}`;
  if (win && typeof win.addEventListener === "function") {
    win.addEventListener("resize", () => {
      clearTimeout(timerResize);
      timerResize = setTimeout(() => {
        const faixa = `${contextoNaBarra()}${railEstreito()}`;
        if (faixa === faixaAnterior) return;
        faixaAnterior = faixa;
        render(ctxStore.getSnapshot());
      }, 120);
    });
  }

  // Clique fora fecha o dropdown aberto (§9 — faltava: só Esc e escolher um
  // item fechavam; clicar em qualquer outro lugar da página deixava o menu
  // aberto por cima do conteúdo, sem jeito óbvio de sair sem usar teclado).
  // Delegado no `document`, não em `host` — o bloco de contexto reparenta
  // para a contextbar em telas estreitas (§19.1) e sai de dentro de `host`.
  if (doc && typeof doc.addEventListener === "function") {
    doc.addEventListener("click", (e) => {
      if (!dropdownAberto) return;
      const dentro = typeof e.target.closest === "function" && e.target.closest(".vf-shell__context");
      if (dentro) return; // gatilhos e itens já fecham pelo próprio handler
      abrirDropdown(null);
    });
  }

  const unsubscribe = ctxStore.subscribe((snap) => render(snap));

  return {
    setUnificacaoUiEnabled(value) {
      const next = value === true;
      if (next === unificacaoUiEnabled) return;
      unificacaoUiEnabled = next;
      render(ctxStore.getSnapshot());
    },
    render,
    dom,
    abrirOperacao: () => abrirDropdown("operacao"),
    fecharDropdowns: () => {
      if (dropdownAberto) abrirDropdown(null);
    },
    destroy: unsubscribe,
    MODULOS,
    GLOBAIS,
    ADMIN,
  };
}

/* ── Cliente de depuração (paridade com layout.js) ───────────────────────
   layout.js:23-64 carrega vf-debug-client.js para ADMIN quando
   localStorage["vf-debug-enabled"] === "true" (ou ?vf_debug=1). Toda página
   já migrada para o Shell V3 tinha perdido isso em silêncio — inclusive as
   que existem para depurar. Portado aqui, com o mesmo gate (admin + token +
   opt-in explícito) e a mesma tolerância a falha: o Portal segue inteiro se
   o script não carregar. A duplicação com layout.js é deliberada e morre
   com ele em F6 — mexer no layout.js legado afetaria 26 páginas de uma vez. */
const DEBUG_ENABLED_KEY = "vf-debug-enabled";
const DEBUG_CLIENT_SRC = "vf-debug-client.js";

function loadDebugClientIfSafe() {
  try {
    const storage = safeLocalStorage();
    if (!storage) return;
    const urlFlag = new URLSearchParams(window.location.search || "").get("vf_debug");
    if (urlFlag === "0" || urlFlag === "false" || urlFlag === "off") {
      storage.setItem(DEBUG_ENABLED_KEY, "false");
      return;
    }
    if (String(readUser().role || "").toLowerCase() !== "admin" || !hasToken()) return;
    if (urlFlag === "1" || urlFlag === "true" || urlFlag === "on") storage.setItem(DEBUG_ENABLED_KEY, "true");
    if (storage.getItem(DEBUG_ENABLED_KEY) !== "true") return;
    if (window.__VF_DEBUG_CLIENT_LOADING__ || window.VFDebugClient) return;
    if (document.querySelector('script[data-vf-debug-client="true"]')) return;

    window.__VF_DEBUG_CLIENT_LOADING__ = true;
    const script = document.createElement("script");
    script.src = DEBUG_CLIENT_SRC;
    script.async = true;
    script.dataset.vfDebugClient = "true";
    script.onerror = () => { window.__VF_DEBUG_CLIENT_LOADING__ = false; };
    (document.head || document.documentElement).appendChild(script);
  } catch {
    /* auxiliar: nenhuma falha aqui pode derrubar o shell */
  }
}

/* ── Boot de produção — só roda em página real, autenticada, sem admin
   próprio de teste (o teste headless usa createVfShell() diretamente com
   um `api`/`context` injetados). */
function bootProduction() {
  if (typeof window === "undefined" || typeof document === "undefined") return null;
  // Sem token não existe nenhuma chamada de API em trânsito para um 401
  // acionar o redirect (vf-api só entra em cena depois de vfContext.init(),
  // que este `return` evita) — sem isto a página fica em branco pra sempre,
  // sem shell/erro/loading, em vez de mandar pro login.
  if (!hasToken()) { window.location.replace("index.html"); return null; }
  const user = readUser();
  // Paridade com layout.js:319-323 — `seller` é uma persona EXTERNA, com
  // área própria. Sem este desvio ela veria a navegação interna inteira
  // (Carteira, Bases, Pessoas, Administração) e só descobriria que não pode
  // usá-la pelos 403 de cada tela. O backend continua sendo quem autoriza;
  // isto é sobre não oferecer a porta errada.
  if (String(user.role || "").toLowerCase() === "seller") { window.location.replace("seller.html"); return null; }
  loadDebugClientIfSafe();
  const scope = document.body ? document.body.dataset.vfScope || "global" : "global";

  const shell = createVfShell({ getUser: readUser });
  if (!shell) return null; // abortou: .vf-sidebar já presente (layout.js)

  vfContext.init({ api: createProductionContextApi(vfApi), user, scope });
  if (String(user.role || "").toLowerCase() === "admin") {
    loadUnificacaoAccess().then((access) => {
      const allowed = access?.uiEnabled === true && access.actor?.role === "admin";
      shell.setUnificacaoUiEnabled(allowed);
      const actions = document.getElementById("clientes-header-acoes");
      if (allowed && actions && !document.getElementById("cu-clientes-shortcut")) {
        const link = document.createElement("a");
        link.id = "cu-clientes-shortcut";
        link.className = "vf-btn vf-btn--secondary";
        link.href = "clientes-unificacao.html";
        link.textContent = "Unificar clientes";
        actions.appendChild(link);
      }
    }).catch(() => { /* flag indisponível mantém apenas este item oculto */ });
  }
  return shell;
}

export const vfShell = typeof document !== "undefined" ? bootProduction() : null;

if (typeof window !== "undefined") {
  window.VF = window.VF || {};
  window.VF.shell = vfShell;
}
