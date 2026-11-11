// server/services/raioX/raioXMotores.js
//
// Catálogo dos MOTORES do Venforce para o Raio-X visual: o que cada um consome,
// onde persiste o que produz, quais snapshots/caches/históricos tem e o que
// impede apagar/reconstruir. Fonte: inventário em docs/banco-de-dados/inventario
// (MATRIZ_DEPENDENCIAS, CLASSIFICACAO_E_RETENCAO) — leitura do código; NADA aqui
// foi checado no banco de produção.
//
// Cada afirmação carrega uma etiqueta de evidência:
//   "confirmado"   — lido no código (arquivo/serviço citado no inventário);
//   "inferido"     — deduzido do padrão do código, sem leitura direta;
//   "nao_mapeado"  — sabemos que existe, mas a ligação NÃO foi investigada.
// Os motores NÃO são alterados: este módulo só descreve.

const { REGISTRO } = require("./raioXRegistro");

const C = "confirmado";
const I = "inferido";
const N = "nao_mapeado";

// Tabelas que o inventário conhece mas o registro do Raio-X (REGISTRO) ainda não
// conta por cliente: aparecem na visão geral (tamanho real) e nas dependências,
// marcadas `foraDoRegistro` (sem contagem por cliente).
const EXTRAS = [
  ["central_vendas_import_pedidos", "Central de Vendas", "vinculo", false, "sim", "reuso de pedidos (migration manual 20261111)"],
  ["central_vendas_mp_settlement_movements", "Mercado Pago", "historico", false, "parcial", "Settlement Report MP"],
  ["cliente_360_diagnostico_itens", "Cliente 360", "derivada", false, "sim", "motor de diagnóstico"],
  ["promo_snapshot_runs", "Promoções", "auditoria", false, "sim", "worker de promoções"],
  ["promo_snapshot_run_lotes", "Promoções", "auditoria", false, "sim", "worker de promoções"],
  ["promocoes_diagnostico_itens", "Promoções", "derivada", false, "sim", "diagnóstico legado"],
  ["promocoes_rebate_jobs", "Promoções", "auditoria", true, "nao", "ação do usuário"],
  ["sentinel_incidente_eventos", "Sentinel", "auditoria", true, "nao", "Sentinel (eventos do incidente)"],
  ["meli_user_products", "Anúncios", "cache", false, "sim", "API ML"],
  ["financeiro_ads_cache", "Ads", "cache", false, "sim", "API ML Ads"],
  ["custos", "Custos e bases", "canonica", true, "nao", "planilha de custos do cliente"],
  ["bases", "Custos e bases", "canonica", true, "nao", "planilha de custos do cliente"],
  ["fechamento_incidentes", "Financeiro e fechamentos", "temporaria", false, "nao", "fechamento (expira em 15 d)"],
  ["observability_requests", "Observabilidade", "log", false, "nao", "middleware"],
  ["activity_logs", "Observabilidade", "auditoria", true, "nao", "controllers (9)"],
].map(([tabela, dominio, classe, manual, reconstruivel, origem]) => ({
  tabela, dominio, classe, manual, reconstruivel, origem, modulos: [], foraDoRegistro: true,
}));

const TABELAS = new Map();
for (const r of REGISTRO) TABELAS.set(r.tabela, { ...r, foraDoRegistro: false });
for (const e of EXTRAS) if (!TABELAS.has(e.tabela)) TABELAS.set(e.tabela, e);

const f = (ref, evidencia, nota = null) => ({ ref, evidencia, nota });
const ext = (ref, evidencia, nota = null) => ({ ref, evidencia, nota, tipo: "fonte_externa" });

const MOTORES = [
  {
    id: "central_vendas", nome: "Central de Vendas (sync)", grupo: "Dados de vendas",
    descricao: "Sincroniza pedidos do ML (e MP) e grava um import por conta × competência. Alimenta quase tudo.",
    gatilhos: [f("POST /operacao/central-vendas/:slug/sync-runs", C), f("scheduler noturno (CENTRAL_VENDAS_NOTURNO_ENABLED)", C)],
    consome: [
      ext("API ML Orders/Shipments/Billing", C), ext("API Mercado Pago (/v1/payments, Settlement)", C),
      f("ml_tokens", C), f("cliente_contas", C), f("base_cliente_vinculos", C, "custo do pedido"), f("custos", C),
      f("ads_resumos_mensais", C, "o sync noturno também grava Ads"),
    ],
    produz: [
      f("central_vendas_imports", C), f("central_vendas_pedidos", C), f("central_vendas_pedido_itens", C), f("central_vendas_componentes", C),
      f("central_vendas_sync_runs", C), f("central_vendas_sync_sources", C),
      f("central_vendas_mp_payments", C), f("central_vendas_mp_payment_charges", C),
      f("central_vendas_mp_settlement_reports", C), f("central_vendas_mp_settlement_movements", C),
      f("central_vendas_import_pedidos", C, "só com o reuso de pedidos ligado"),
    ],
    telas: ["Central de Vendas", "Painel de Contas (status do sync)"],
    naoMapeado: ["Quantos clientes/contas o scheduler noturno cobre hoje em produção (depende de env)."],
  },
  {
    id: "painel_contas", nome: "Painel de Contas", grupo: "Operação",
    descricao: "Fechamento operacional por semana/conta: lê imports, resumo do Cliente 360 e lançamentos manuais.",
    gatilhos: [f("Atualizar dados (sob demanda)", C), f("atualização automática do Painel (modo manual por padrão)", C)],
    consome: [f("central_vendas_imports", C), f("central_vendas_pedidos", C), f("central_vendas_componentes", C), f("central_vendas_sync_runs", C),
      f("cliente_360_resumos_mensais", C), f("ads_resumos_mensais", C), f("painel_contas_lancamentos_manuais", C), f("cliente_responsaveis", C, "gate de acesso")],
    produz: [f("painel_contas_lancamentos_manuais", C, "digitação do usuário"), f("painel_contas_lancamentos_manuais_historico", C)],
    telas: ["Painel de Contas"],
    naoMapeado: [],
  },
  {
    id: "cliente_360", nome: "Cliente 360", grupo: "Operação",
    descricao: "Resumo mensal por cliente (FAT/LC/MC), diagnósticos e ações. O adapter noturno deriva do import da Central.",
    gatilhos: [f("sync do Cliente 360", C), f("adapter noturno (centralVendasCliente360Adapter)", C)],
    consome: [f("central_vendas_imports", C), f("central_vendas_pedidos", C), f("central_vendas_pedido_itens", C), f("ads_resumos_mensais", C),
      f("entregas_cliente", C), f("relatorios", C), f("cliente_360_frete_historico", C, "lida; ninguém grava")],
    produz: [f("cliente_360_resumos_mensais", C), f("cliente_360_diagnosticos", C), f("cliente_360_diagnostico_itens", C),
      f("cliente_360_sync_jobs", C), f("cliente_360_acoes", C, "digitação do usuário")],
    telas: ["Cliente 360", "Dashboard", "Painel de Contas (resumo)"],
    naoMapeado: ["Origem do cliente_360_frete_historico: o código só lê, não há escritor."],
  },
  {
    id: "margem", nome: "Motor de Margem / Central de Margem", grupo: "Preço e margem",
    descricao: "Projeta margem por anúncio (snapshot), calcula realizado e aplica preço no ML pelo cockpit.",
    gatilhos: [f("MARGIN_SNAPSHOT_WORKER_ENABLED + gatilhos pós-sync/base/manual", C), f("MARGEM_PROJETADA_SCHEDULER_ENABLED (legado)", C)],
    consome: [f("custos", C), f("base_cliente_vinculos", C), f("meli_anuncios", C), f("central_vendas_imports", C, "realizado"),
      f("central_vendas_pedidos", C), f("central_vendas_componentes", C), f("promo_snapshot_itens", C, "oportunidades"), f("ml_tokens", C)],
    produz: [f("margin_snapshot_runs", C), f("margin_projection_snapshots", C), f("anuncios_margem_projetada_snapshot", C, "legado, fallback"),
      f("margem_precificacao_aplicacoes", C, "auditoria do preço aplicado no ML"), ext("API ML: altera preço", C)],
    telas: ["Central de Margem", "Anúncios ML"],
    naoMapeado: ["Quanto cada snapshot ocupa por conta em produção (só tamanho da tabela inteira é medido)."],
  },
  {
    id: "promocoes", nome: "Central de Promoções", grupo: "Preço e margem",
    descricao: "Mantém snapshot das promoções do ML por conta (somente leitura); a Margem decide, Anúncios ML executa.",
    gatilhos: [f("PROMO_SNAPSHOT_WORKER_ENABLED (desligado por padrão)", C), f("PROMO_SNAPSHOT_CLIENTES", C)],
    consome: [ext("API ML promoções", C), f("ml_tokens", C), f("meli_anuncios", I), f("promocoes_diagnosticos", C, "legado, via promoSnapshotLegado")],
    produz: [f("promo_snapshot_contas", C), f("promo_snapshot_runs", C), f("promo_snapshot_run_lotes", C), f("promo_snapshot_itens", C),
      f("promocoes_diagnosticos", C, "legado"), f("promocoes_diagnostico_itens", C), f("promocoes_rebate_jobs", C)],
    telas: ["Central de Margem (Promoções)", "promocoes-retorno", "Automações"],
    naoMapeado: ["Consumo de meli_anuncios pelo worker de promoções: não confirmado."],
  },
  {
    id: "sentinel", nome: "Sentinel (pedidos ao vivo)", grupo: "Monitoramento",
    descricao: "Polling incremental dos pedidos ML, margem por pedido e incidentes.",
    gatilhos: [f("SENTINEL_WORKER_ENABLED", C)],
    consome: [ext("API ML Orders (polling)", C), f("ml_tokens", C), f("custos", C, "sentinelCusto"), f("base_cliente_vinculos", C),
      f("cliente_squad_history", C, "gate de acesso"), f("cliente_responsaveis", C)],
    produz: [f("sentinel_checkpoints", C), f("sentinel_pedidos", C), f("sentinel_pedido_excecoes", C), f("sentinel_incidentes", C), f("sentinel_incidente_eventos", C)],
    telas: ["Pedidos ao vivo (Sentinel)"],
    naoMapeado: ["Relação entre sentinel_pedidos e central_vendas_pedidos (o mesmo pedido ML é calculado por dois motores): não verificada."],
  },
  {
    id: "conciliacao_mp", nome: "Conciliação Mercado Pago", grupo: "Dados de vendas",
    descricao: "Cruza payments/charges e Settlement com o import vigente. Auxiliar: não entra em pedido, margem nem fechamento.",
    gatilhos: [f("Financeiro V3 (aba) / read/mercado-pago/reconciliation", C)],
    consome: [f("central_vendas_mp_payments", C, "só runs dos imports vigentes"), f("central_vendas_mp_payment_charges", C),
      f("central_vendas_mp_settlement_reports", C), f("central_vendas_mp_settlement_movements", C), f("central_vendas_imports", C)],
    produz: [],
    telas: ["Financeiro V3 (indireto)"],
    naoMapeado: [],
  },
  {
    id: "financeiro", nome: "Financeiro / Fechamento via API", grupo: "Operação",
    descricao: "Fechamento do cliente a partir do import; publica entregas com link público.",
    gatilhos: [f("Financeiro V3", C)],
    consome: [f("central_vendas_imports", C), f("central_vendas_pedidos", C), f("base_cliente_vinculos", C), f("financeiro_ads_cache", I), f("meli_anuncios", C, "miniaturas")],
    produz: [f("entregas_cliente", C, "documento entregue / link público"), f("fechamento_incidentes", C, "temporário (15 d)"), f("financeiro_ads_cache", I)],
    telas: ["Financeiro V3", "relatório público"],
    naoMapeado: ["Motor de fechamento Shopee/TikTok: tabelas próprias não inventariadas."],
  },
  {
    id: "anuncios_ml", nome: "Anúncios ML / Otimizador", grupo: "Preço e margem",
    descricao: "Cache dos anúncios do ML, otimizações assistidas por IA e criação de anúncios.",
    gatilhos: [f("meliSyncService (sob demanda)", C)],
    consome: [ext("API ML itens", C), f("ml_tokens", C), f("custos", C)],
    produz: [f("meli_anuncios", C), f("meli_user_products", C), f("meli_anuncio_otimizacoes", C), f("meli_anuncio_publicacoes", C)],
    telas: ["Anúncios ML", "Criar anúncios"],
    naoMapeado: [],
  },
  {
    id: "ads", nome: "Ads", grupo: "Dados de vendas",
    descricao: "Resumo mensal de Ads por cliente (upload ou sync noturno) e acompanhamentos.",
    gatilhos: [f("upload (adsController)", C), f("sync noturno (centralVendasAdsSyncService)", C)],
    consome: [ext("API ML Ads", C), ext("planilha de Ads (upload)", C)],
    produz: [f("ads_resumos_mensais", C, "identificado só por cliente_slug"), f("ads_acompanhamentos", C), f("financeiro_ads_cache", I)],
    telas: ["Ads", "Cliente 360", "Painel de Contas"],
    naoMapeado: ["Ads não tem conta (só cliente_slug): não dá para separar por conta."],
  },
  {
    id: "outros", nome: "Demais motores (Design Studio, Relatórios, Seller, Shopee, TikTok)", grupo: "Não mapeados em profundidade",
    descricao: "Existem no código, mas o fluxo de dados deles NÃO foi investigado nesta missão.",
    gatilhos: [], consome: [f("shopee_grants", C), f("relatorios", C), f("design_templates", C)],
    produz: [f("relatorios", C), f("design_templates", C), f("design_artworks", C), f("shopee_grants", C)],
    telas: [],
    naoMapeado: ["Quem consome relatorios fora do Cliente 360.", "Fluxo Shopee/TikTok além do OAuth.", "Design Studio: leitores e escritores completos."],
  },
];


// ---------------------------------------------------------------------------
// "Como funciona": etapas e acionamento por motor. Fonte ÚNICA: os fluxos de
// docs/banco-de-dados/inventario/MATRIZ_DEPENDENCIAS.md (leitura do código) e os
// gatilhos já catalogados acima. Sem fluxo documentado ⇒ lista vazia ⇒ a tela
// mostra "Não mapeado" (nada é inventado). Nenhum motor é executado ou alterado.
// ---------------------------------------------------------------------------
const e = (texto, evidencia = C) => ({ texto, evidencia });
const a = (tipo, texto, evidencia = C) => ({ tipo, texto, evidencia }); // tipo: manual | agendado | automatico | evento

const COMO_FUNCIONA = {
  central_vendas: {
    etapas: [
      e("Um gatilho abre um run de sync (central_vendas_sync_runs / sync_sources)."),
      e("O sync lê Orders, Shipments e Billing do Mercado Livre (e pagamentos/Settlement do Mercado Pago) e aplica o custo da base vinculada."),
      e("persistCentralVendasImport grava um import por conta × competência, com pedidos → itens → componentes, primeiro como candidate."),
      e("A publicação promove o candidate a published; o vigente é escolhido pela seleção canônica de cobertura."),
      e("Painel, Financeiro, Cliente 360 e Margem leem o import vigente."),
    ],
    acionamento: [a("manual", "Botão/rota POST /operacao/central-vendas/:slug/sync-runs"), a("agendado", "Scheduler noturno interno (opt-in: CENTRAL_VENDAS_NOTURNO_ENABLED)")],
  },
  painel_contas: {
    etapas: [
      e("Lê os imports vigentes (pedidos e composição), o resumo mensal do Cliente 360, o Ads e o status dos runs."),
      e("Soma por semana/conta e junta os lançamentos manuais digitados pelo usuário."),
      e("A tela /painel-contas exibe o consolidado e a comparação por conta."),
    ],
    acionamento: [a("manual", "\"Atualizar dados\" sob demanda pelo usuário"), a("automatico", "Atualização automática existe, mas o padrão é o modo manual")],
  },
  cliente_360: {
    etapas: [
      e("O adapter noturno lê o import vigente publicado de cada conta (nunca candidate/legacy)."),
      e("Consolida FAT/LC/MC com o cálculo oficial da Central (consolidarCentral) e aplica a precedência do fechamento publicado para o MC."),
      e("Grava o snapshot em cliente_360_resumos_mensais sob lock por (cliente, competência) e registra o job em cliente_360_sync_jobs."),
      e("O motor de diagnóstico gera cliente_360_diagnosticos; o usuário registra ações em cliente_360_acoes."),
    ],
    acionamento: [a("agendado", "Adapter noturno (centralVendasCliente360Adapter)"), a("manual", "Sync do Cliente 360 pela tela")],
  },
  margem: {
    etapas: [
      e("Gatilhos (pós-sync, mudança de base, manual) acordam o worker de snapshot."),
      e("O worker lê custos/bases e os anúncios (meli_anuncios) e calcula a margem projetada por item."),
      e("Grava o estado atual em margin_projection_snapshots (1 por item) e o run em margin_snapshot_runs."),
      e("A Central de Margem e /anuncios-meli leem o snapshot; as oportunidades combinam com os snapshots de promoção."),
      e("No cockpit, o usuário aplica preço no ML; a ação fica em margem_precificacao_aplicacoes."),
    ],
    acionamento: [a("evento", "Gatilhos pós-sync / base / manual (MARGIN_SNAPSHOT_WORKER_ENABLED)"), a("agendado", "Scheduler de margem projetada legado (MARGEM_PROJETADA_SCHEDULER_ENABLED)")],
  },
  promocoes: {
    etapas: [
      e("O worker lê as promoções do ML por conta (somente leitura) e abre um run com lotes."),
      e("Grava promo_snapshot_itens e atualiza o ponteiro de vigência (promo_snapshot_contas)."),
      e("Poda os runs antigos (mantém os últimos PROMO_SNAPSHOT_RUNS_RETIDOS)."),
      e("precificacaoOportunidadesService combina promoções, margem e o legado (promoSnapshotLegado) e a Central de Margem exibe."),
    ],
    acionamento: [a("agendado", "Worker (PROMO_SNAPSHOT_WORKER_ENABLED — desligado por padrão), restrito aos clientes de PROMO_SNAPSHOT_CLIENTES")],
  },
  sentinel: {
    etapas: [
      e("O worker (SENTINEL_WORKER_ENABLED) executa o polling incremental dos pedidos ML por conta, guardando o ponto em sentinel_checkpoints."),
      e("sentinelPedidoService.calcularPedido calcula a margem por pedido com o custo da base e grava sentinel_pedidos."),
      e("sentinelExcecoes registra exceções; avaliarIncidentesConta abre/atualiza sentinel_incidentes (e eventos)."),
      e("A tela Pedidos ao vivo lista os incidentes; o usuário reconhece/resolve e a transição volta ao motor de incidentes."),
    ],
    acionamento: [a("agendado", "Worker de polling (SENTINEL_WORKER_ENABLED)"), a("manual", "Resolver/transicionar incidentes pela tela")],
  },
  conciliacao_mp: {
    etapas: [
      e("Os payments, charges e Settlement já vêm gravados pelo sync da Central (este motor só lê)."),
      e("Conciliation/Mp3Read cruza os payments dos runs dos imports vigentes com o import e com o Settlement."),
      e("financeiroVisaoService expõe o resultado na aba de conciliação do Financeiro V3 (não entra em pedido, margem nem fechamento)."),
    ],
    acionamento: [a("manual", "Leitura sob demanda (aba do Financeiro V3 / rota read/mercado-pago/reconciliation)"), a("automatico", "A coleta que o alimenta roda dentro do sync da Central (flag CENTRAL_VENDAS_MP_PAYMENTS_COLETA_ENABLED)")],
  },
  financeiro: {
    etapas: [
      e("fechamentoViaApiService lê o import vigente (e a conciliação MP) do cliente."),
      e("Monta o fechamento e a tela Financeiro V3 o exibe."),
      e("A entrega publicada vira entregas_cliente com link público (ligação deduzida do inventário, sem leitura direta do fluxo de publicação).", I),
    ],
    acionamento: [a("manual", "Tela Financeiro V3 (fechamento pelo usuário)")],
  },
  anuncios_ml: {
    etapas: [
      e("meliSyncService (via meliAnunciosService/meliFamiliaService) traz os anúncios do ML para meli_anuncios e meli_user_products."),
      e("O otimizador grava sugestões em meli_anuncio_otimizacoes (aprovação humana) e a criação grava meli_anuncio_publicacoes."),
    ],
    acionamento: [a("manual", "Sincronização e ações pela tela Anúncios ML")],
  },
  ads: {
    etapas: [
      e("O resumo mensal entra por upload (adsController) ou pelo sync noturno (centralVendasAdsSyncService) em ads_resumos_mensais."),
      e("O usuário registra acompanhamentos em ads_acompanhamentos."),
    ],
    acionamento: [a("manual", "Upload da planilha de Ads"), a("agendado", "Sync noturno de Ads")],
  },
  outros: { etapas: [], acionamento: [] },
};

// Duplicações/compartilhamentos CONHECIDOS (curadoria do inventário). Os
// compartilhamentos por tabela (2+ motores) são calculados abaixo.
const DUPLICACOES = [
  { id: "margem_legado", titulo: "Margem projetada em duas tabelas", tabelas: ["margin_projection_snapshots", "anuncios_margem_projetada_snapshot"], evidencia: C,
    nota: "A tabela legada duplica a nova e só serve de fallback para /anuncios-meli." },
  { id: "promo_legado", titulo: "Promoções em snapshot novo e diagnóstico legado", tabelas: ["promo_snapshot_itens", "promocoes_diagnosticos", "promocoes_diagnostico_itens"], evidencia: C,
    nota: "promoSnapshotLegado ainda lê o legado como fallback." },
  { id: "imports_copias", titulo: "Cópias superadas dos imports da Central", tabelas: ["central_vendas_imports", "central_vendas_pedidos", "central_vendas_pedido_itens", "central_vendas_componentes"], evidencia: C,
    nota: "Cada sync cria um import novo; o reuso de pedidos (quando ligado) evita regravar os inalterados." },
  { id: "mp_copias", titulo: "Payments do Mercado Pago repetidos por run", tabelas: ["central_vendas_mp_payments", "central_vendas_mp_payment_charges"], evidencia: C,
    nota: "Chave (run, payment): o mesmo payment_id é gravado de novo a cada run. ≈14 cópias por payment no diagnóstico de 05/11 (estimativa)." },
  { id: "c360_derivado", titulo: "Resumo mensal derivado do mesmo import", tabelas: ["cliente_360_resumos_mensais", "central_vendas_imports"], evidencia: C,
    nota: "O adapter noturno recalcula FAT/LC/MC a partir do import; reconstruível." },
  { id: "ads_duas_tabelas", titulo: "Ads em duas tabelas", tabelas: ["ads_resumos_mensais", "financeiro_ads_cache"], evidencia: I,
    nota: "Cache do Financeiro parece repetir dado de Ads; não verificado campo a campo." },
  { id: "pedido_dois_motores", titulo: "Mesmo pedido ML em Sentinel e Central", tabelas: ["sentinel_pedidos", "central_vendas_pedidos"], evidencia: N,
    nota: "Ambos calculam margem por pedido a partir da API ML; a sobreposição não foi medida." },
];

// ---------------------------------------------------------------------------
// Derivados (puros, testáveis)
// ---------------------------------------------------------------------------
const soTabelas = (lista) => lista.filter((x) => x.tipo !== "fonte_externa" && TABELAS.has(x.ref));

function indiceTabelas() {
  const idx = new Map();
  for (const t of TABELAS.values()) idx.set(t.tabela, { ...t, escritores: [], leitores: [] });
  for (const m of MOTORES) {
    for (const p of soTabelas(m.produz)) idx.get(p.ref).escritores.push({ motor: m.id, evidencia: p.evidencia, nota: p.nota });
    for (const c of soTabelas(m.consome)) idx.get(c.ref).leitores.push({ motor: m.id, evidencia: c.evidencia, nota: c.nota });
  }
  return idx;
}

// Por que uma tabela NÃO pode ser apagada/reconstruída sem cuidado.
function restricoesDaTabela(t) {
  const out = [];
  const leitoresOutros = t.leitores.filter((l) => !t.escritores.some((e) => e.motor === l.motor));
  if (t.manual) out.push({ tipo: "manual", severidade: "alta", motivo: "Protegido: dado de ação humana ou auditoria — não é reconstruível.", evidencia: C });
  if (t.reconstruivel === "nao" && !t.manual) out.push({ tipo: "irreconstruivel", severidade: "media", motivo: "Não há como regenerar (histórico/auditoria).", evidencia: C });
  if (t.reconstruivel === "parcial") out.push({ tipo: "parcial", severidade: "media", motivo: "Só reconstruível em parte (depende de janela da API ou de ação do usuário).", evidencia: I });
  if (leitoresOutros.length) {
    out.push({ tipo: "consumidores", severidade: "alta", motivo: `Lida por: ${leitoresOutros.map((l) => l.motor).join(", ")}.`, motores: leitoresOutros.map((l) => l.motor), evidencia: leitoresOutros.every((l) => l.evidencia === C) ? C : I });
  }
  if (!t.escritores.length && !t.leitores.length) out.push({ tipo: "nao_mapeada", severidade: "info", motivo: "Nenhum motor mapeado escreve ou lê esta tabela.", evidencia: N });
  return out;
}

function catalogo() {
  const idx = indiceTabelas();
  const tabelas = [...idx.values()].map((t) => {
    const compartilhada = new Set([...t.escritores.map((e) => e.motor), ...t.leitores.map((l) => l.motor)]).size > 1;
    return { ...t, compartilhada, restricoes: restricoesDaTabela(t) };
  });
  const motores = MOTORES.map((m) => {
    const produz = m.produz.map((p) => ({ ...p, meta: TABELAS.get(p.ref) ? { classe: TABELAS.get(p.ref).classe, dominio: TABELAS.get(p.ref).dominio, manual: TABELAS.get(p.ref).manual } : null }));
    const consome = m.consome.map((c) => ({ ...c, meta: TABELAS.get(c.ref) ? { classe: TABELAS.get(c.ref).classe, dominio: TABELAS.get(c.ref).dominio } : null }));
    const persistidas = soTabelas(m.produz).map((p) => p.ref);
    const porClasse = {};
    for (const ref of persistidas) { const k = TABELAS.get(ref).classe; (porClasse[k] ||= []).push(ref); }
    const compartilhadas = [...new Set([...soTabelas(m.consome), ...soTabelas(m.produz)].map((x) => x.ref))]
      .filter((ref) => idx.get(ref) && new Set([...idx.get(ref).escritores, ...idx.get(ref).leitores].map((x) => x.motor)).size > 1)
      .map((ref) => ({ tabela: ref, comMotores: [...new Set([...idx.get(ref).escritores, ...idx.get(ref).leitores].map((x) => x.motor))].filter((x) => x !== m.id) }));
    const cf = COMO_FUNCIONA[m.id] || { etapas: [], acionamento: [] };
    const alimenta = [];
    for (const outro of MOTORES) {
      if (outro.id === m.id) continue;
      const tabs = soTabelas(outro.consome).map((x) => x.ref).filter((ref) => persistidas.includes(ref));
      if (tabs.length) alimenta.push({ motor: outro.id, nome: outro.nome, tabelas: [...new Set(tabs)] });
    }
    const comoFunciona = {
      finalidade: { texto: m.descricao, evidencia: m.id === "outros" ? N : C },
      etapas: cf.etapas, acionamento: cf.acionamento,
      resultado: { grava: [...new Set(persistidas)], alimenta },
      ondeAparece: m.telas,
      naoMapeado: [...(cf.etapas.length ? [] : ["Sequência de etapas deste motor"]), ...(cf.acionamento.length ? [] : ["Como é acionado"]), ...(m.telas.length ? [] : ["Em qual tela aparece"])],
    };
    return {
      ...m, produz, consome, comoFunciona, snapshotsCachesHistoricos: porClasse, compartilhadas,
      bloqueiosDeExclusao: persistidas.map((ref) => ({ tabela: ref, restricoes: restricoesDaTabela(idx.get(ref)).filter((r) => r.tipo !== "nao_mapeada") })).filter((x) => x.restricoes.length),
    };
  });
  const confirmados = (lista) => lista.filter((x) => x.evidencia === C).length;
  const resumo = {
    motores: motores.length,
    ligacoes: motores.reduce((s, m) => s + m.consome.length + m.produz.length, 0),
    confirmadas: motores.reduce((s, m) => s + confirmados(m.consome) + confirmados(m.produz), 0),
    inferidas: motores.reduce((s, m) => s + m.consome.concat(m.produz).filter((x) => x.evidencia === I).length, 0),
    naoMapeados: motores.reduce((s, m) => s + m.naoMapeado.length, 0) + DUPLICACOES.filter((d) => d.evidencia === N).length,
    tabelasCompartilhadas: tabelas.filter((t) => t.compartilhada).length,
  };
  return { versao: "raio-x-motores/v1", resumo, motores, tabelas, duplicacoes: DUPLICACOES, legenda: { confirmado: "lido no código", inferido: "deduzido do padrão, sem leitura direta", nao_mapeado: "existe, mas não foi investigado" } };
}

module.exports = { catalogo, MOTORES, TABELAS, EXTRAS, DUPLICACOES, restricoesDaTabela, indiceTabelas };
