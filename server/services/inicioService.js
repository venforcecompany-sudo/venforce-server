// server/services/inicioService.js
//
// GET /operacao/inicio/:cliente?conta=&periodo=hoje|7d|30d|90d
//
// Tela de Início do Portal (substitui a Visão): a mesma leitura da tela de
// Início do Lucratto 360 — resultado do período com comparação, o que pede
// atenção, saúde da conta (reputação do ML), saúde do catálogo (status de
// margem), MercadoLíder, gráfico de faturamento × lucro por dia e os
// produtos que mais lucraram / mais perdem — mais os dois blocos que a Visão
// já tinha e continuam: Ads e a checklist de configuração da operação.
//
// Nenhuma fórmula financeira nova: as vendas vêm do MESMO contrato de pedido
// da Central de Vendas (resolveRangeContext + buildPayloadFromRange), o
// catálogo do Motor de Margem (obterResumo), o Ads do mlAdsService e a
// checklist do Cliente 360. Os períodos atual, anterior e a janela do
// MercadoLíder são lidos numa ÚNICA carga do banco (o intervalo que cobre os
// três) e separados aqui por data do pedido.
//
// Cada bloco é independente (envelope `bloco` da Visão): a falha de um nunca
// derruba os outros.

const { createCentralVendasService, buildPayloadFromRange, buildResumoFromRange, pedidoEntraNoResultado } = require("./centralVendas/centralVendasService");
const { resolveMarketplaceAccountContext } = require("./clienteContas/clienteContaService");
const { getCliente360 } = require("./cliente360/cliente360Service");
const { obterResumo: obterResumoMargem } = require("./motorMargem/motorMargemService");
const { buscarPerformanceML } = require("./ads/mlAdsService");
const { mlFetch } = require("../utils/mlClient");
const { asDate } = require("./centralVendas/centralVendasRepository");
const { resolverContaObrigatoria, bloco } = require("./visaoService");
const visaoDeps = require("./clienteContas/clienteContaService");

const PERIODOS = {
  hoje: { dias: 1, rotulo: "Hoje" },
  "7d": { dias: 7, rotulo: "7 dias" },
  "30d": { dias: 30, rotulo: "30 dias" },
  "90d": { dias: 90, rotulo: "90 dias" },
};
const PERIODO_PADRAO = "30d";

// Metas e limites do MercadoLíder (mesma fonte do Lucratto,
// packages/contrato/src/reputacao.ts).
const METAS_MERCADO_LIDER = [
  { nivel: "silver", rotulo: "MercadoLíder", vendas: 230, faturamento: 37000 },
  { nivel: "gold", rotulo: "MercadoLíder Gold", vendas: 575, faturamento: 118400 },
  { nivel: "platinum", rotulo: "MercadoLíder Platinum", vendas: 1725, faturamento: 296000 },
];
const LIMITES_MERCADO_LIDER = { reclamacoesPct: 0.5, cancelamentosPct: 0.5, atrasosPct: 6, mesesDeConta: 4 };

// Status do Motor de Margem → chaves da tela (as mesmas do Lucratto).
const STATUS_MOTOR = {
  HEALTHY: "saudavel",
  LOW_MARGIN: "margem_baixa",
  LOSS: "prejuizo",
  SUSPECT_DATA: "dado_suspeito",
  UNVALIDATED: "nao_validado",
  RECONCILING: "conciliando",
};

function criarErroHttp(statusCode, mensagem, extra = {}) {
  const err = new Error(mensagem);
  err.statusCode = statusCode;
  Object.assign(err, extra);
  return err;
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

// ─── Datas (sempre AAAA-MM-DD no fuso de São Paulo) ──────────────────────────

function hojeEmSaoPaulo(agora = new Date()) {
  const partes = new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(agora);
  const parte = (tipo) => partes.find((p) => p.type === tipo).value;
  return `${parte("year")}-${parte("month")}-${parte("day")}`;
}

function somarDias(dia, dias) {
  const data = new Date(`${dia}T12:00:00Z`);
  data.setUTCDate(data.getUTCDate() + dias);
  return data.toISOString().slice(0, 10);
}

// Começo da janela do MercadoLíder: dia 1º do mês, 3 meses antes do atual.
function inicioJanelaLider(hoje) {
  const [ano, mes] = hoje.split("-").map(Number);
  return new Date(Date.UTC(ano, mes - 1 - 3, 1)).toISOString().slice(0, 10);
}

// `dadosAte` = último dia com pedidos sincronizados (o sync diário cobre até
// ontem). Os períodos de 7/30/90 dias terminam nele — senão o mês corrente
// inteiro cairia fora (a Central só usa um import que cobre o trecho pedido
// todo) e a comparação com o período anterior ficaria torta. "Hoje" continua
// sendo hoje: sem pedidos de hoje, a tela avisa em vez de mostrar zero.
function resolverPeriodoInicio(periodoRaw, agora = new Date(), dadosAte = null) {
  const informado = periodoRaw !== undefined && periodoRaw !== null && String(periodoRaw).trim() !== "";
  const id = informado ? String(periodoRaw).trim() : PERIODO_PADRAO;
  const def = PERIODOS[id];
  if (!def) {
    throw criarErroHttp(400, `periodo inválido: use ${Object.keys(PERIODOS).join(", ")}.`, { code: "PERIODO_INVALIDO" });
  }
  const hoje = hojeEmSaoPaulo(agora);
  const ultimoDia = dadosAte && dadosAte < hoje ? dadosAte : hoje;
  const fim = id === "hoje" ? hoje : ultimoDia;
  const de = somarDias(fim, -(def.dias - 1));
  const anteriorAte = somarDias(de, -1);
  const anteriorDe = somarDias(anteriorAte, -(def.dias - 1));
  return {
    id,
    rotulo: def.rotulo,
    hoje,
    dadosAte: dadosAte || null,
    atual: { de, ate: fim },
    anterior: { de: anteriorDe, ate: anteriorAte },
    lider: { de: inicioJanelaLider(hoje), ate: ultimoDia },
  };
}

function diasDoIntervalo({ de, ate }) {
  const dias = [];
  for (let d = de; d <= ate; d = somarDias(d, 1)) dias.push(d);
  return dias;
}

const dentro = (intervalo) => (pedido) => pedido.data && pedido.data >= intervalo.de && pedido.data <= intervalo.ate;

// ─── Vendas (Central de Vendas) ──────────────────────────────────────────────

// Totais no formato da tela: lucro = soma do resultado dos pedidos com
// resultado calculado (honestidade de ausência: sem nenhum, lucro null).
function totaisDoPeriodo(pedidos) {
  const r = buildResumoFromRange({}, pedidos);
  const validos = pedidos.filter(pedidoEntraNoResultado);
  const calculados = validos.filter((p) => p.resultado !== null && p.resultado !== undefined);
  const faturamentoCalculado = round2(calculados.reduce((s, p) => s + Number(p.valor || 0), 0));
  const lucro = calculados.length ? round2(calculados.reduce((s, p) => s + Number(p.resultado || 0), 0)) : null;
  return {
    faturamento: r.faturamento,
    vendas: r.pedidosValidos,
    unidades: r.unidades,
    canceladas: r.cancelados,
    vendasCalculadas: calculados.length,
    incompletas: validos.length - calculados.length,
    faturamentoCalculado,
    lucro,
    // Margem sobre o faturamento CALCULADO (o lucro só existe nesses pedidos).
    margemPct: lucro !== null && faturamentoCalculado > 0 ? round2((lucro / faturamentoCalculado) * 100) : null,
    ticket: r.ticket,
    semCusto: r.semCusto,
    confiancaFechamento: r.confiancaFechamento,
  };
}

function serieDiaria(pedidos, intervalo) {
  const mapa = new Map(diasDoIntervalo(intervalo).map((dia) => [dia, { dia, vendas: 0, faturamento: 0, lucro: 0 }]));
  for (const p of pedidos) {
    const ponto = mapa.get(p.data);
    if (!ponto || !pedidoEntraNoResultado(p)) continue;
    ponto.vendas += 1;
    ponto.faturamento += Number(p.valor || 0);
    if (p.resultado !== null && p.resultado !== undefined) ponto.lucro += Number(p.resultado);
  }
  return [...mapa.values()].map((p) => ({ ...p, faturamento: round2(p.faturamento), lucro: round2(p.lucro) }));
}

// Lucro por produto: soma o resultado de cada ITEM (já persistido por item
// pelo motor da Central — nunca rateio do pedido). Só itens com resultado
// entram no lucro e na margem.
function produtosDoPeriodo(pedidos) {
  const mapa = new Map();
  for (const p of pedidos) {
    if (!pedidoEntraNoResultado(p)) continue;
    for (const item of p.itens || []) {
      if (!item.mlb) continue;
      if (!mapa.has(item.mlb)) {
        mapa.set(item.mlb, { mlb: item.mlb, titulo: item.titulo || null, unidades: 0, faturamento: 0, vendasCalculadas: 0, faturamentoCalculado: 0, lucro: 0 });
      }
      const prod = mapa.get(item.mlb);
      prod.unidades += Number(item.quantidade || 0);
      prod.faturamento += Number(item.receitaProduto || 0);
      if (item.resultado !== null && item.resultado !== undefined) {
        prod.vendasCalculadas += 1;
        prod.faturamentoCalculado += Number(item.receitaProduto || 0);
        prod.lucro += Number(item.resultado);
      }
    }
  }
  return [...mapa.values()].map((p) => ({
    mlb: p.mlb,
    titulo: p.titulo,
    unidades: p.unidades,
    faturamento: round2(p.faturamento),
    vendasCalculadas: p.vendasCalculadas,
    lucro: round2(p.lucro),
    margemPct: p.faturamentoCalculado > 0 ? round2((p.lucro / p.faturamentoCalculado) * 100) : null,
  }));
}

function rankings(produtos) {
  const calculados = produtos.filter((p) => p.vendasCalculadas > 0);
  return {
    lucraram: calculados.filter((p) => p.lucro > 0).sort((a, b) => b.lucro - a.lucro).slice(0, 5),
    perdem: calculados.filter((p) => p.lucro < 0).sort((a, b) => a.lucro - b.lucro).slice(0, 5),
  };
}

async function carregarVendas({ cliente, conta, periodo }, d) {
  // Carga até o último dia sincronizado: pedir um dia que nenhum import
  // cobre faria a Central descartar o mês inteiro desse dia.
  const ultimoDia = periodo.dadosAte && periodo.dadosAte < periodo.hoje ? periodo.dadosAte : periodo.hoje;
  const carga = { de: [periodo.anterior.de, periodo.lider.de].sort()[0], ate: ultimoDia };
  const lido = await d.carregarPedidos({ cliente, conta, intervalo: carga });
  const { sincronizado, pedidos } = lido;
  const atualizadoEm = periodo.atualizadoEm || lido.atualizadoEm;
  const doAtual = pedidos.filter(dentro(periodo.atual));
  const doAnterior = pedidos.filter(dentro(periodo.anterior));
  const daJanelaLider = pedidos.filter(dentro(periodo.lider)).filter(pedidoEntraNoResultado);

  const totais = totaisDoPeriodo(doAtual);
  const anteriorTotais = totaisDoPeriodo(doAnterior);
  // Sem nenhuma venda no período anterior não há base de comparação.
  const anterior = anteriorTotais.vendas > 0 || anteriorTotais.canceladas > 0
    ? { ...anteriorTotais, periodo: periodo.anterior }
    : null;

  return {
    sincronizado,
    atualizadoEm,
    dadosAte: periodo.dadosAte,
    // Pediu "Hoje" e os pedidos de hoje ainda não foram sincronizados.
    hojePendente: periodo.id === "hoje" && !!periodo.dadosAte && periodo.dadosAte < periodo.hoje,
    totais,
    anterior,
    serie: serieDiaria(doAtual, periodo.atual),
    ...rankings(produtosDoPeriodo(doAtual)),
    lider: {
      de: periodo.lider.de,
      ate: periodo.lider.ate,
      vendas: daJanelaLider.length,
      faturamento: round2(daJanelaLider.reduce((s, p) => s + Number(p.valor || 0), 0)),
    },
  };
}

// Contrato canônico de pedido da Central de Vendas para o intervalo inteiro
// (mesma seleção de snapshot/conta da tela da Central). snapshot null =
// nenhum import cobre o período (nunca sincronizado).
async function carregarPedidosCentral({ cliente, conta, intervalo }) {
  const { cliente: clienteCv, snapshot, dateFrom, dateTo } = await createCentralVendasService().resolveRangeContext(cliente.slug, {
    dateFrom: intervalo.de, dateTo: intervalo.ate, marketplace: conta.marketplace, clienteContaId: conta.id,
  });
  const payload = buildPayloadFromRange(clienteCv, { dateFrom, dateTo }, snapshot);
  return { sincronizado: snapshot !== null, atualizadoEm: payload.motor?.geradoEm || null, pedidos: payload.pedidos || [] };
}

// Até que dia há pedidos sincronizados desta conta: o import escolhido pela
// Central para o 1º dia do mês corrente (mesma seleção de snapshot/conta) diz
// até onde ele cobre. Sem import no mês (dia 1º, antes do sync), vale o fim
// do mês anterior. Nada sincronizado recentemente = null (usa hoje).
async function carregarCoberturaCentral({ cliente, conta, hoje }) {
  const svc = createCentralVendasService();
  const importDoDia = async (dia) => {
    const r = await svc.resolveRangeImports(cliente.slug, { dateFrom: dia, dateTo: dia, marketplace: conta.marketplace, clienteContaId: conta.id });
    return r.imports[r.imports.length - 1] || null;
  };
  const primeiroDoMes = `${hoje.slice(0, 7)}-01`;
  let imp = await importDoDia(primeiroDoMes);
  let dadosAte = null;
  if (imp) {
    const cobertura = asDate(imp.coverage_date_to);
    dadosAte = cobertura && cobertura < hoje ? cobertura : hoje;
  } else {
    const fimMesAnterior = somarDias(primeiroDoMes, -1);
    imp = await importDoDia(fimMesAnterior);
    if (imp) dadosAte = fimMesAnterior;
  }
  const quando = imp && (imp.published_at || imp.updated_at || imp.created_at);
  return { dadosAte, atualizadoEm: quando ? new Date(quando).toISOString() : null };
}

// ─── Catálogo (Motor de Margem) ──────────────────────────────────────────────

async function carregarCatalogo({ cliente, conta, periodo }, d) {
  const resumo = await d.obterResumoMargem({
    clienteSlug: cliente.slug, clienteContaId: conta.id, dateFrom: periodo.atual.de, dateTo: periodo.atual.ate,
  });
  const porStatus = { saudavel: 0, margem_baixa: 0, prejuizo: 0, dado_suspeito: 0, nao_validado: 0, conciliando: 0 };
  for (const [status, n] of Object.entries(resumo.placar?.porStatus || {})) {
    const chave = STATUS_MOTOR[status];
    if (chave) porStatus[chave] += Number(n) || 0;
  }
  const prejuizos = (resumo.excecoes || []).filter((e) => e.status === "LOSS");
  const margens = prejuizos
    .map((e) => (e.margemRealizadaPercent ?? e.margemProjetadaPercent))
    .filter((m) => m !== null && m !== undefined && Number.isFinite(Number(m)));
  return {
    porStatus,
    total: Object.values(porStatus).reduce((s, n) => s + n, 0),
    margemAlvoPct: resumo.margemAlvo === null || resumo.margemAlvo === undefined ? null : round2(Number(resumo.margemAlvo) * 100),
    piorMargemPct: margens.length ? Math.min(...margens.map(Number)) : null,
    cobertura: resumo.cobertura || null,
  };
}

// ─── Reputação (GET /users/{id} do Mercado Livre) ────────────────────────────

const NIVEIS = ["1_red", "2_orange", "3_yellow", "4_light_green", "5_green"];
const LIDERES = ["silver", "gold", "platinum"];

function inteiroOuNull(v) {
  return Number.isSafeInteger(v) && v >= 0 ? v : null;
}

// `rate` do ML é fração (0,0131 = 1,31%); fora do formato vira null.
function metrica(bruta) {
  const m = bruta || {};
  const taxa = typeof m.rate === "number" && Number.isFinite(m.rate) && m.rate >= 0 ? Number((m.rate * 100).toFixed(4)) : null;
  return { taxaPct: taxa, quantidade: inteiroOuNull(m.value) };
}

function diasDoPeriodo(periodo) {
  const m = typeof periodo === "string" ? /^(\d+)\s*days?$/i.exec(periodo.trim()) : null;
  return m ? Number(m[1]) : null;
}

function lerReputacaoMl(usuario) {
  const r = usuario?.seller_reputation || {};
  return {
    nivel: NIVEIS.includes(r.level_id) ? r.level_id : null,
    mercadoLider: LIDERES.includes(r.power_seller_status) ? r.power_seller_status : null,
    periodoDias: diasDoPeriodo(r.metrics?.sales?.period),
    vendasPeriodo: inteiroOuNull(r.metrics?.sales?.completed),
    reclamacoes: metrica(r.metrics?.claims),
    cancelamentos: metrica(r.metrics?.cancellations),
    atrasos: metrica(r.metrics?.delayed_handling_time),
    contaDesde: typeof usuario?.registration_date === "string" ? usuario.registration_date : null,
  };
}

async function carregarReputacao({ cliente, conta }, d) {
  const contexto = await d.resolveMarketplaceAccountContext({
    clienteSlug: cliente.slug, marketplace: "meli", clienteContaId: conta.id,
    requireUsableGrant: true, strictIdentity: true, resolveBase: false,
  });
  if (!contexto.mlUserId) throw new Error("Conta sem token do Mercado Livre configurado.");
  const resp = await d.mlFetch(contexto.cliente.id, `/users/${encodeURIComponent(contexto.mlUserId)}`, {
    mlUserId: contexto.mlUserId, timeoutMs: 8000,
  });
  if (!resp.ok) throw new Error(`O Mercado Livre não devolveu a reputação (HTTP ${resp.status}).`);
  return { ...lerReputacaoMl(resp.data), lidaEm: new Date().toISOString() };
}

// ─── Composição ──────────────────────────────────────────────────────────────

async function obterInicio({ clienteSlugRaw, clienteContaIdRaw, periodoRaw }, deps = {}) {
  const d = {
    resolverClientePorIdOuSlug: visaoDeps.resolverClientePorIdOuSlug,
    obterConta: visaoDeps.obterConta,
    sanitizarConta: visaoDeps.sanitizarConta,
    carregarPedidos: carregarPedidosCentral,
    carregarCobertura: carregarCoberturaCentral,
    obterResumoMargem,
    buscarPerformanceML,
    getCliente360,
    resolveMarketplaceAccountContext,
    mlFetch,
    agora: () => new Date(),
    ...deps,
  };

  const { cliente, conta } = await resolverContaObrigatoria({ clienteSlugRaw, clienteContaIdRaw }, d);
  const agora = d.agora();
  resolverPeriodoInicio(periodoRaw, agora); // valida antes de qualquer leitura
  // Falha ao ler a cobertura não derruba a tela: cai no comportamento de hoje.
  const cobertura = await d.carregarCobertura({ cliente, conta, hoje: hojeEmSaoPaulo(agora) }).catch(() => null);
  const periodo = { ...resolverPeriodoInicio(periodoRaw, agora, cobertura?.dadosAte || null), atualizadoEm: cobertura?.atualizadoEm || null };
  const isMeli = conta.marketplace === "meli";
  const soMeli = (nome) => ({ escopoConta: true, aplicavel: isMeli, motivoInaplicavel: `${nome} está disponível só para operações Mercado Livre.` });
  const ctx = { cliente, conta, periodo };

  const [vendas, catalogo, reputacao, ads, configuracao] = await Promise.all([
    bloco({ escopoConta: true }, () => carregarVendas(ctx, d)),
    bloco(soMeli("A saúde do catálogo"), () => carregarCatalogo(ctx, d)),
    bloco(soMeli("A reputação"), () => carregarReputacao(ctx, d)),
    bloco(soMeli("Ads"), () =>
      d.buscarPerformanceML(cliente.slug, periodo.hoje.slice(0, 7), { from: periodo.atual.de, to: periodo.atual.ate }, conta.id, { strictIdentity: true })
    ),
    // Checklist de configuração (mesma fonte da Visão: Cliente 360, escopo do
    // cliente inteiro). Só o que a tela usa — não o dossiê todo.
    bloco({ escopoConta: false }, async () => {
      const c360 = await d.getCliente360(cliente.slug, { competencia: periodo.hoje.slice(0, 7) });
      return { setup: c360?.setup || {}, sync: c360?.sync || {} };
    }),
  ]);

  return {
    contexto: {
      clienteId: cliente.id, clienteSlug: cliente.slug, clienteNome: cliente.nome || null,
      clienteContaId: conta.id, contaNome: conta.externalAccountLabel || conta.nome || null, marketplace: conta.marketplace,
    },
    periodo: { id: periodo.id, rotulo: periodo.rotulo, hoje: periodo.hoje, dadosAte: periodo.dadosAte, de: periodo.atual.de, ate: periodo.atual.ate, anterior: periodo.anterior },
    metasMercadoLider: METAS_MERCADO_LIDER,
    limitesMercadoLider: LIMITES_MERCADO_LIDER,
    vendas,
    catalogo,
    reputacao,
    ads,
    configuracao,
  };
}

module.exports = {
  obterInicio,
  resolverPeriodoInicio,
  totaisDoPeriodo,
  serieDiaria,
  produtosDoPeriodo,
  rankings,
  lerReputacaoMl,
  hojeEmSaoPaulo,
  PERIODOS,
};
