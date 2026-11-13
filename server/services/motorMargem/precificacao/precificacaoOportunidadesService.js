// server/services/motorMargem/precificacao/precificacaoOportunidadesService.js
// "Oportunidades de preço e promoção" da Central de Margem — SEM N+1.
//
// Nenhuma chamada ao Mercado Livre. Fontes persistidas, uma consulta cada,
// para a conta inteira:
//   1. PROMO SNAPSHOT da conta (promo_snapshot_itens do run atual, mantido
//      pelo Promo Snapshot Worker — docs/PROMO_SNAPSHOT_ACCOUNT_SYNC.md), já
//      casado numa única consulta com o Margin Snapshot DA MESMA conta
//      (custo, imposto, taxa fixa, taxa de comissão e frete projetados);
//   2. realizado da Central de Vendas no período (unidades/receita por MLB).
// Enquanto a conta nunca teve Promo Snapshot, cai no último diagnóstico
// concluído da tela antiga Promoções ML (compatibilidade, marcado como
// `diagnostico_legado`) — a Central não depende mais dessa tela.
//
// FONTE ÚNICA: toda resposta traz `fontePromocoes` (promoSnapshotFonte), o
// MESMO objeto que a Bancada (POST /simular) devolve: estado de sincronização,
// rótulo, último bom, falha e legado. A tela só o renderiza.
//
// Abrir/paginar dispara o auto-trigger (ensureFreshPromoSnapshot): só
// enfileira em background, nunca espera o scan.
//
// UMA FÓRMULA SÓ: cada linha é um cenário do `core.calcularCenario` — o mesmo
// que o POST /api/margem/simular usa (LC', margem', ΔLC, empate de volume,
// banca ML/seller e veredito entrar | entrar_se_girar | nao_entrar |
// bloqueado). O banco só seleciona as promoções elegíveis (SQL sem fórmula);
// o cálculo, a ordem e a página acontecem aqui.
//
// COTAÇÃO: a lista não consulta o ML, então comissão' e frete' são ESTIMADOS
// do snapshot (comissão = taxa de comissão do snapshot × P'; frete = o do
// snapshot). Por isso toda linha sai `estimado: true`, `cotacao.ao_vivo:
// false` e `mudou_faixa_frete: null` (a faixa de frete só se sabe cotando).
// A estimativa é DITA, nunca escondida; sem a taxa de comissão do snapshot não
// há estimativa — a linha sai `bloqueado`. O veredito exato (cotação real em
// P', `bloqueado` se a cotação falhar) é o do /simular, que o drawer chama.
//
// ORDEM (explicável): veredito (entrar, entrar_se_girar, nao_entrar,
// bloqueado) e, dentro dele, o impacto ΔLC × unidades do período (os últimos
// 30 dias até ontem, por padrão). Sem vendas no período não há impacto total:
// a linha leva `sem_historico` e fica depois das que têm histórico, por ΔLC
// por unidade. Uma linha por anúncio (a melhor promoção), com `opcoes_total`.

const pool = require("../../../config/database");
const core = require("../core");
const { carregarRebatesDaConta, rebateAplicavel, MOTIVO_REBATE } = require("../margemAtualRebate");
const { sqlOportunidadesElegiveis, lerLinhas } = require("./precificacaoOportunidadesSql");
const { criarCotadorEmP, cotacaoParaNucleo, evidenciaDaCotacao, mapComLimite } = require("../margemCotacaoEmP");
const { classificarPromocao } = require("./promocaoClassificacao");
const { resolvePromoSnapshotConfig } = require("../../promoSnapshot/promoSnapshotConfig");
const { montarFontePromocoes } = require("../../promoSnapshot/promoSnapshotFonte");
const { obterDiagnosticoLegado, STATUS_SQL, STATUS_ACEITOS_SQL } = require("../../promoSnapshot/promoSnapshotLegado");

const FRESCO_MIN = 360; // 6h — mesmos limiares de promocoesDiagnosticoService
const ANTIGO_MIN = 1440; // 24h
const LIMITE_PADRAO = 20;
const LIMITE_MAX = 50;

const { VEREDITOS } = core;
const TIER = { [VEREDITOS.ENTRAR]: 0, [VEREDITOS.ENTRAR_SE_GIRAR]: 1, [VEREDITOS.NAO_ENTRAR]: 2, [VEREDITOS.BLOQUEADO]: 3 };
// Sem filtro explícito a lista é "oportunidades": o que vale entrar (ou entrar girando).
const VEREDITOS_PADRAO = [VEREDITOS.ENTRAR, VEREDITOS.ENTRAR_SE_GIRAR];
const LOGISTICA_SEM_FRETE_PREVISTO = new Set(["not_specified", "custom", ""]);

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round2(v) {
  return v === null ? null : Math.round((v + Number.EPSILON) * 100) / 100;
}

function iso(valor) {
  if (!valor) return null;
  const d = valor instanceof Date ? valor : new Date(valor);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function erroHttp(statusCode, codigo, motivo) {
  const err = new Error(motivo);
  err.statusCode = statusCode;
  err.code = codigo;
  err.payload = { ok: false, codigo, code: codigo, erro: motivo, motivo };
  return err;
}

function frescor(createdAt, agora) {
  const ts = new Date(createdAt).getTime();
  if (!Number.isFinite(ts)) return { idadeMinutos: null, frescor: null };
  const idadeMinutos = Math.floor((agora - ts) / 60000);
  return { idadeMinutos, frescor: idadeMinutos > ANTIGO_MIN ? "antigo" : idadeMinutos > FRESCO_MIN ? "atencao" : "atual" };
}

function defaults(deps = {}) {
  return {
    db: deps.db || pool,
    resolverContaDoCliente: deps.resolverContaDoCliente || require("../marginSnapshotApiService").resolverContaDoCliente,
    obterConta: deps.obterConta || require("../../clienteContas/clienteContaService").obterConta,
    carregarRealizada:
      deps.carregarRealizada || require("../marginSnapshotReadService").carregarRealizadaDoPeriodo,
    now: deps.now || (() => new Date()),
    env: deps.env || process.env,
    // Cotação AO VIVO da página (só com ?cotacao=viva) — injetável nos testes.
    buscarComissaoEFrete: deps.buscarComissaoEFrete || ((...a) => require("../../shared/marketplaceCurrentQuoteService").buscarComissaoEFrete(...a)),
    mlFetch: deps.mlFetch || ((...a) => require("../../../utils/mlClient").mlFetch(...a)),
    obterAnuncios: deps.obterAnuncios || (async (clienteId, itemIds) => {
      const r = await (deps.db || pool).query(
        `SELECT item_id, listing_type_id, category_id, logistic_type FROM meli_anuncios WHERE cliente_id = $1 AND item_id = ANY($2::text[])`,
        [clienteId, itemIds]
      );
      return new Map(r.rows.map((x) => [x.item_id, x]));
    }),
    // Tipos de promoção que a camada segura da Central escreve (decide o grupo e a ação).
    tiposComEscrita: deps.tiposComEscrita || null,
    // Promo Snapshot (injetável nos testes).
    promo: deps.promo || {
      estadoComAutoTrigger: (identidade, opts) =>
        require("../../promoSnapshot/promoSnapshotReadService").estadoComAutoTrigger(identidade, opts, deps),
      syncPublico: (e, g) => require("../../promoSnapshot/promoSnapshotReadService").syncPublico(e, g),
      listarElegiveis: (args) =>
        (deps.repo || require("../../promoSnapshot/promoSnapshotRepository")).listarOportunidadesElegiveis(args, deps.db || pool),
    },
  };
}

// ─── Elegibilidade para o ranking ────────────────────────────────────────────
// Oportunidade = promoção que o anúncio AINDA PODE entrar e que baixa o preço.
//   - promoção já em andamento (`started`/`active`) → `ativa`: o anúncio já está
//     nela, não é oportunidade (e o preço atual já é o promocional);
//   - P' >= preço atual → `sem_desconto_efetivo`: entrar não baixaria o preço.
// A mesma regra está na consulta (precificacaoOportunidadesSql), que só traz
// as elegíveis; aqui ela é reconferida linha a linha.
const STATUS_PROMOCAO_ATIVA = new Set(core.STATUS_PROMOCAO_ATIVA);
const MOTIVO_FORA_DO_RANKING = { ATIVA: "ativa", SEM_DESCONTO: "sem_desconto_efetivo" };

/** null = elegível; senão o motivo público de ficar fora do ranking. */
function motivoForaDoRanking({ status, precoPromo, precoAtual }) {
  if (STATUS_PROMOCAO_ATIVA.has(String(status || "").toLowerCase())) return MOTIVO_FORA_DO_RANKING.ATIVA;
  const p = num(precoPromo);
  const atual = num(precoAtual);
  // Sem preço atual não há como afirmar desconto: fora, nunca "elegível por falta de dado".
  if (p === null || atual === null || p >= atual) return MOTIVO_FORA_DO_RANKING.SEM_DESCONTO;
  return null;
}

const TEXTO_VEREDITO = {
  [VEREDITOS.ENTRAR]: "vale entrar",
  [VEREDITOS.ENTRAR_SE_GIRAR]: "entrar só se girar mais",
  [VEREDITOS.NAO_ENTRAR]: "não entrar",
  [VEREDITOS.BLOQUEADO]: "sem veredito",
};

function motivoDa(linha) {
  const partes = [];
  if (linha.retornoMl) partes.push(`retorno ML de R$ ${linha.retornoMl.toFixed(2).replace(".", ",")}`);
  if (linha.unidades) partes.push(`${linha.unidades} un. vendidas no período`);
  if (linha.margemDepois !== null) partes.push(`margem pós-promoção ${(linha.margemDepois * 100).toFixed(1).replace(".", ",")}%`);
  if (linha.veredito) {
    partes.push(linha.veredito === VEREDITOS.BLOQUEADO && linha.veredito_motivo
      ? `${TEXTO_VEREDITO[linha.veredito]} (${linha.veredito_motivo})`
      : TEXTO_VEREDITO[linha.veredito]);
  }
  return partes.join(" · ");
}

// Meta de margem da linha: a do snapshot; ausente/inválida = padrão do Motor.
function metaDaLinha(snap) {
  const bruta = num(snap.target_margin ?? snap.snap_target_margin);
  return bruta !== null && bruta > 0 && bruta < 1
    ? { margem_alvo: bruta, margem_minima: 0 }
    : { margem_alvo: core.DEFAULT_TARGET_MARGIN, margem_minima: 0 };
}

// Preço CHEIO (sem promoção) para o "quem banca": o do item (`list_price` do
// Margin Snapshot) e, só se o item não o tem, o `original_price` da promoção;
// a fonte vai junto. Sem nenhum dos dois o núcleo diz `sem_preco_cheio`.
function precoCheioDaLinha(snap, precoOriginalPromo) {
  const doItem = num(snap.list_price);
  if (doItem !== null && doItem > 0) return { preco_cheio: doItem, preco_cheio_fonte: "margin_snapshot" };
  const daPromo = num(precoOriginalPromo);
  if (daPromo !== null && daPromo > 0) return { preco_cheio: daPromo, preco_cheio_fonte: "promo_snapshot" };
  return { preco_cheio: null, preco_cheio_fonte: null };
}

// Uma candidata a partir de (promoção, snapshot de margem) — mesma régua para
// as duas fontes. null = fora do ranking (ativa / sem desconto efetivo).
function montarCandidata(args) {
  const { itemId, promocao, precoPromo, precoOriginalPromo = null, retornoMl, snap, titulo, vendasPorMlb, vendasIndisponivel = false, rebateAtual = null, rebateIndisponivel = null, rebatePromoSnapshot = undefined, cotacaoReal = null, listaFonte = "promo_snapshot", listaObservadaEm = null } = args;
  if (motivoForaDoRanking({ status: promocao && promocao.status, precoPromo, precoAtual: snap.price })) return null;

  // Composição de hoje: a mesma da tabela (snapshot + retorno ML em andamento).
  // O retorno de hoje sai do MESMO classificador da tabela: só o da promoção
  // que forma o preço do snapshot, com financiamento comprovado.
  const decisaoRebate = rebateAtual
    ? rebateAplicavel({ price: snap.price, listPrice: snap.list_price }, rebateAtual, { promoSnapshot: rebatePromoSnapshot })
    : { rebate: null, ambiguo: false };
  const rebateEmAndamento = decisaoRebate.rebate === null || decisaoRebate.rebate === undefined ? null : Number(decisaoRebate.rebate);
  const rebateAmbiguo = decisaoRebate.ambiguo === true;
  const logistica = snap.anuncio_logistic_type === undefined || snap.anuncio_logistic_type === null ? null : String(snap.anuncio_logistic_type);
  // Logística combinável não tem frete previsto: zero declarado. Tipo desconhecido (sem
  // cadastro do anúncio) não é "combinável": frete ausente continua ausente.
  const freteAplicavel = !(logistica !== null && LOGISTICA_SEM_FRETE_PREVISTO.has(logistica));
  const taxa = num(snap.commission_rate);
  const meta = metaDaLinha(snap);

  const calc = core.calcularCenario({
    atual: {
      preco: num(snap.price), custo: num(snap.cost), aliquota: num(snap.tax_rate), taxa_fixa: num(snap.fixed_fee),
      comissao: num(snap.commission), frete: num(snap.freight), rebate: rebateEmAndamento === null ? 0 : rebateEmAndamento,
    },
    cenario: { tipo: "promo", preco: num(precoPromo), rebate: retornoMl || 0, status_promocao: promocao && promocao.status, ...precoCheioDaLinha(snap, precoOriginalPromo) },
    // Sem cotação real, a estimativa é DECLARADA (sem consulta ao ML): taxa de comissão do snapshot × P' e frete do snapshot.
    cotacao: cotacaoReal
      ? cotacaoParaNucleo(cotacaoReal)
      : { comissao: taxa === null ? null : round2(num(precoPromo) * taxa), frete: num(snap.freight), frete_aplicavel: freteAplicavel },
    meta,
    flags: {
      rebate_ambiguo: rebateAmbiguo,
      rebate_atual_indisponivel: rebateIndisponivel === MOTIVO_REBATE.PROMO_SNAPSHOT_INDISPONIVEL,
    },
  });

  // De onde vêm os NÚMEROS da linha (nunca rotular "ao vivo" o que não é):
  //   simular     — cotação REAL completa (comissão e frete em P') sobre a lista do Promo Snapshot: a mesma
  //                 entrada, o mesmo núcleo e o mesmo resultado do POST /api/margem/simular para o cenário;
  //   estimativa  — comissão = taxa do snapshot × P' e frete do snapshot (sem consulta ao ML), ou lista do
  //                 diagnóstico legado (o /simular não lê essa fonte: P' e retorno ML não são os dele);
  //   bloqueado   — a cotação foi tentada e não veio completa: o veredito é `bloqueado`, nada é estimado.
  const cotacaoCompleta = Boolean(cotacaoReal) && cotacaoReal.comissao !== null && cotacaoReal.comissao !== undefined &&
    (cotacaoReal.frete_aplicavel === false || (cotacaoReal.frete !== null && cotacaoReal.frete !== undefined));
  let numerosOrigem;
  let numerosMotivo = null;
  if (!cotacaoReal) { numerosOrigem = "estimativa"; numerosMotivo = "comissao_e_frete_do_snapshot"; }
  else if (!cotacaoCompleta) { numerosOrigem = "bloqueado"; numerosMotivo = "cotacao_indisponivel"; }
  else if (listaFonte !== "promo_snapshot") { numerosOrigem = "estimativa"; numerosMotivo = "lista_do_diagnostico_legado"; }
  else numerosOrigem = "simular";

  const vendas = vendasPorMlb.get(itemId) || null;
  const unidades = vendasIndisponivel ? null : vendas ? num(vendas.unidades) || 0 : 0;
  const temHistorico = unidades !== null && unidades > 0;
  const impacto = temHistorico && calc.delta_lc !== null ? round2(calc.delta_lc * unidades) : null;

  const linha = {
    itemId,
    titulo: snap.titulo || titulo || itemId,
    imagem: snap.image_url || null,
    precoAtual: num(snap.price),
    // Mesma margem atual da tabela e do drawer: com o retorno ML da promoção
    // em andamento do anúncio (margemAtualRebate), quando existe.
    margemAtual: calc.atual.margem_ratio,
    margemAtualRebate: rebateEmAndamento,
    promocao,
    precoPromocao: num(precoPromo),
    retornoMl: retornoMl || null,
    margemDepois: calc.cenario.margem_ratio,
    lucroDepois: calc.cenario.lc,
    // Vendas indisponíveis (Central de Vendas falhou): null, nunca "0 un.".
    unidades,
    receita: vendasIndisponivel ? null : vendas ? num(vendas.receita) : null,
    estimado: numerosOrigem === "estimativa",
    numeros: { origem: numerosOrigem, motivo: numerosMotivo },
    // De qual lista veio a promoção (e quando): a fonte da linha, separada da origem dos números.
    lista: { fonte: listaFonte, observada_em: listaObservadaEm },
    // O mesmo cenário do /simular:
    veredito: calc.veredito,
    veredito_motivo: calc.motivo,
    bloqueios: calc.motivos,
    delta_lc: calc.delta_lc,
    delta_margem_ratio: calc.delta_margem_ratio,
    empate_volume: calc.empate_volume,
    preco_cheio: calc.preco_cheio,
    preco_cheio_fonte: calc.preco_cheio_fonte,
    desconto_total: calc.desconto_total,
    desconto_ratio: calc.desconto_ratio,
    ml_banca: calc.ml_banca,
    seller_banca: calc.seller_banca,
    delta_preco_atual: calc.delta_preco_atual,
    delta_preco: calc.delta_preco,
    variacao_preco_ratio: calc.variacao_preco_ratio,
    frase: calc.frase,
    banca_motivo: calc.banca_motivo,
    banca_aviso: calc.banca_aviso,
    impacto_lc: impacto,
    flags: {
      ...calc.flags,
      // A faixa de frete só se conhece cotando: estimando, a lista não afirma.
      mudou_faixa_frete: cotacaoCompleta ? calc.flags.mudou_faixa_frete : null,
      sem_historico: !temHistorico,
    },
    atual: calc.atual,
    cenario: calc.cenario,
    meta: calc.meta,
    // Mesmo formato do /simular: "de onde saiu a diferença no lucro" e a
    // fonte do frete/comissão na cascata (cotação real só quando houve uma).
    efeitos: calc.efeitos,
    explicacao: calc.explicacao,
    evidencia: cotacaoReal ? evidenciaDaCotacao(cotacaoReal) : null,
    cotacao: cotacaoReal
      ? {
        // `ao_vivo` só quando comissão E frete vieram do ML; cotação tentada que falhou diz o porquê.
        ao_vivo: cotacaoCompleta, fonte: "ml_listing_prices", consultado_em: cotacaoReal.consultado_em, evidencia: evidenciaDaCotacao(cotacaoReal),
        ...(cotacaoCompleta ? {} : { falhou: true, motivo: "A cotação ao vivo não veio completa para este preço; nada foi estimado." }),
      }
      : {
        ao_vivo: false,
        fonte: "estimada_snapshot",
        comissao_taxa: taxa,
        motivo: "Estimativa: comissão = taxa do snapshot × P'; frete = o do snapshot. A cotação ao vivo confirma.",
      },
    opcoes_total: 1,
  };
  linha.motivo = motivoDa(linha);
  // Entradas guardadas (fora do JSON) para refazer o mesmo cenário com a cotação real.
  Object.defineProperty(linha, "__args", { value: args, enumerable: false });
  return linha;
}

// Cópia que preserva as entradas guardadas (o spread não leva propriedade não enumerável).
function copiarCandidata(c, extra = {}) {
  const copia = { ...c, ...extra };
  if (c.__args) Object.defineProperty(copia, "__args", { value: c.__args, enumerable: false });
  return copia;
}

// Opção (outra promoção do mesmo anúncio): só o que a linha expandida mostra.
function resumoDaOpcao(c) {
  return {
    promocao: c.promocao,
    precoPromocao: c.precoPromocao,
    retornoMl: c.retornoMl,
    veredito: c.veredito,
    veredito_motivo: c.veredito_motivo,
    delta_lc: c.delta_lc,
    margemDepois: c.margemDepois,
    lucroDepois: c.lucroDepois,
    seller_banca: c.seller_banca,
    ml_banca: c.ml_banca,
    desconto_total: c.desconto_total,
    banca_motivo: c.banca_motivo,
    banca_aviso: c.banca_aviso,
    flags: c.flags,
    estimado: c.estimado,
    numeros: c.numeros,
  };
}

// Ordem das candidatas: veredito → com histórico antes de sem histórico →
// impacto (ΔLC × unidades, ou ΔLC por unidade sem histórico) → item → promoção.
function compararCandidatas(a, b) {
  const tier = TIER[a.veredito] - TIER[b.veredito];
  if (tier) return tier;
  const histA = a.flags.sem_historico ? 1 : 0;
  const histB = b.flags.sem_historico ? 1 : 0;
  if (histA !== histB) return histA - histB;
  const medida = (c) => (c.flags.sem_historico ? c.delta_lc : c.impacto_lc);
  const ma = medida(a);
  const mb = medida(b);
  if (ma !== mb) {
    if (ma === null) return 1;
    if (mb === null) return -1;
    return mb - ma;
  }
  if (a.itemId !== b.itemId) return a.itemId < b.itemId ? -1 : 1;
  const ca = String(a.promocao && (a.promocao.chave || a.promocao.id) || "");
  const cb = String(b.promocao && (b.promocao.chave || b.promocao.id) || "");
  return ca < cb ? -1 : ca > cb ? 1 : 0;
}

// Ordens que a tela oferece (só leitura; nenhuma muda o cálculo nem a melhor
// promoção do anúncio — só a sequência da lista). Ausente = "impacto", a ordem
// padrão (compararCandidatas). Valor nulo vai para o fim; empate cai na padrão.
const ORDENS = {
  impacto: null,
  subsidio: { campo: (c) => c.ml_banca, sentido: -1 },
  lucro: { campo: (c) => c.delta_lc, sentido: -1 },
  margem: { campo: (c) => c.margemDepois, sentido: -1 },
  desconto: { campo: (c) => c.desconto_ratio, sentido: -1 },
  fim: { campo: (c) => { const t = c.promocao && c.promocao.fim ? Date.parse(c.promocao.fim) : NaN; return Number.isFinite(t) ? t : null; }, sentido: 1 },
};

function comparadorDaOrdem(ordem) {
  const spec = ordem ? ORDENS[ordem] : null;
  if (!spec) return compararCandidatas;
  return (a, b) => {
    const va = num(spec.campo(a));
    const vb = num(spec.campo(b));
    if (va !== vb) {
      if (va === null) return 1;
      if (vb === null) return -1;
      return (va - vb) * spec.sentido;
    }
    return compararCandidatas(a, b);
  };
}

// Busca por título ou MLB, sem acento e sem caixa ("mlb123", "123" ou parte do título).
function normalizarBusca(texto) {
  return String(texto || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

function casaBusca(c, termo) {
  if (!termo) return true;
  const titulo = normalizarBusca(c.titulo);
  const item = normalizarBusca(c.itemId);
  const semPrefixo = termo.replace(/^mlb/, "");
  return titulo.includes(termo) || item.includes(termo) || (semPrefixo !== "" && item.replace(/^mlb/, "").includes(semPrefixo));
}

/**
 * Ranking das candidatas: UMA linha por anúncio (a melhor promoção), filtro por
 * veredito sobre essa linha, ordem e página. Pura — o serviço e os testes usam
 * a mesma função. `busca` e `tipo` recortam ANTES da contagem por veredito (os
 * números dos filtros falam do mesmo recorte); `ordem` só muda a sequência.
 */
function rankearOportunidades(candidatas, { page, limit, veredito = VEREDITOS_PADRAO, tipo = null, busca = null, ordem = null }) {
  // Tipos de promoção presentes (para o filtro da tela): contados ANTES de filtrar por tipo.
  const tiposMap = new Map();
  for (const c of candidatas) {
    const t = c.promocao && c.promocao.tipo ? String(c.promocao.tipo) : null;
    if (t) tiposMap.set(t, (tiposMap.get(t) || 0) + 1);
  }
  const tipos = Array.from(tiposMap, ([nome, total]) => ({ tipo: nome, total })).sort((a, b) => (a.tipo < b.tipo ? -1 : 1));
  const alvo = tipo ? String(tipo).toLowerCase() : null;
  const termo = busca ? normalizarBusca(busca) : "";
  const base = candidatas.filter((c) =>
    (!alvo || String((c.promocao && c.promocao.tipo) || "").toLowerCase() === alvo) && casaBusca(c, termo));

  const porItem = new Map();
  for (const c of base) {
    const grupo = porItem.get(c.itemId);
    if (!grupo) porItem.set(c.itemId, { melhor: c, todas: [c] });
    else {
      grupo.todas.push(c);
      if (compararCandidatas(c, grupo.melhor) < 0) grupo.melhor = c;
    }
  }
  const melhores = [];
  const contagem = { [VEREDITOS.ENTRAR]: 0, [VEREDITOS.ENTRAR_SE_GIRAR]: 0, [VEREDITOS.NAO_ENTRAR]: 0, [VEREDITOS.BLOQUEADO]: 0 };
  for (const { melhor, todas } of porItem.values()) {
    contagem[melhor.veredito] += 1;
    const outras = todas.filter((c) => c !== melhor).sort(compararCandidatas);
    melhores.push(copiarCandidata(melhor, { opcoes_total: todas.length, opcoes: outras.map(resumoDaOpcao) }));
  }
  // Resumo das promoções que valem entrar (KPI "Promos com +LC"): quantos anúncios e o
  // impacto ΔLC × unidades dos que têm histórico de vendas (sem histórico não há impacto total).
  const entrar = melhores.filter((c) => c.veredito === VEREDITOS.ENTRAR);
  const comImpacto = entrar.filter((c) => c.impacto_lc !== null && c.impacto_lc !== undefined);
  const resumo = {
    entrar: entrar.length,
    impacto_lc: round2(comImpacto.reduce((soma, c) => soma + c.impacto_lc, 0)),
    com_historico: comImpacto.length,
    sem_historico: entrar.length - comImpacto.length,
  };
  const aceitos = veredito === null ? melhores : melhores.filter((c) => veredito.includes(c.veredito));
  aceitos.sort(comparadorDaOrdem(ordem));
  const inicio = (page - 1) * limit;
  return {
    total: aceitos.length,
    pagina: aceitos.slice(inicio, inicio + limit),
    hasNext: inicio + limit < aceitos.length,
    contagem,
    resumo,
    tipos,
  };
}

// `veredito` da requisição: CSV de entrar|entrar_se_girar|nao_entrar|bloqueado
// ou `todos`. Valor desconhecido = 400 (um filtro ignorado mostraria "tudo"
// como se fosse o filtro).
function parseVeredito(bruto) {
  if (bruto === undefined || bruto === null || String(bruto).trim() === "") return VEREDITOS_PADRAO.slice();
  const valores = String(bruto).split(",").map((v) => v.trim().toLowerCase()).filter(Boolean);
  if (valores.includes("todos")) return null;
  const validos = Object.values(VEREDITOS);
  const invalidos = valores.filter((v) => !validos.includes(v));
  if (invalidos.length) {
    throw erroHttp(400, "FILTRO_INVALIDO", `Filtro "veredito" inválido. Aceitos: ${validos.join(", ")} ou todos.`);
  }
  return Array.from(new Set(valores));
}

// `tipo` da requisição: texto livre (tipo da promoção do ML); vazio = todos.
function parseTipo(bruto) {
  if (bruto === undefined || bruto === null || String(bruto).trim() === "") return null;
  return String(bruto).trim().slice(0, 80);
}

// `busca`: texto livre (título ou MLB); vazio = sem busca.
function parseBusca(bruto) {
  if (bruto === undefined || bruto === null || String(bruto).trim() === "") return null;
  return String(bruto).trim().slice(0, 80);
}

// `ordem`: uma das ORDENS; vazio = impacto. Desconhecida = 400 (ordem ignorada
// mostraria a padrão como se fosse a pedida).
function parseOrdem(bruto) {
  if (bruto === undefined || bruto === null || String(bruto).trim() === "") return null;
  const v = String(bruto).trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(ORDENS, v)) {
    throw erroHttp(400, "FILTRO_INVALIDO", `Parâmetro "ordem" inválido. Aceitos: ${Object.keys(ORDENS).join(", ")}.`);
  }
  return v === "impacto" ? null : v;
}

// `cotacao`: "estimada" (padrão, sem ML) ou "viva" (cota só a página, ao vivo).
function parseCotacao(bruto) {
  if (bruto === undefined || bruto === null || String(bruto).trim() === "") return "estimada";
  const v = String(bruto).trim().toLowerCase();
  if (v !== "estimada" && v !== "viva") throw erroHttp(400, "FILTRO_INVALIDO", 'Parâmetro "cotacao" inválido. Aceitos: estimada, viva.');
  return v;
}

async function carregarVendas(d, cliente, conta, params, deps) {
  try {
    const realizada = await d.carregarRealizada(
      { cliente: { id: cliente.id, slug: cliente.slug }, conta: { id: conta.id }, periodo: params.periodo || null },
      { ...deps, db: d.db }
    );
    // `indisponivel` = a Central de Vendas falhou / nada sincronizado: as
    // linhas saem com unidades/receita null e a resposta diz por quê.
    return { vendasPorMlb: realizada.porMlb || new Map(), periodo: realizada.periodo || null, indisponivel: realizada.indisponivel || null };
  } catch (_) {
    return {
      vendasPorMlb: new Map(),
      periodo: null,
      indisponivel: { motivo: "CENTRAL_VENDAS_FALHOU", mensagem: "A leitura de vendas falhou; unidades e receita ficaram indisponíveis (não são zero)." },
    };
  }
}

// Campos públicos de "realizado indisponível" (null + motivo), só quando há.
function vendasPublico(indisponivel) {
  return indisponivel
    ? { vendas: { realizado: null, realizado_motivo: indisponivel.motivo, realizado_mensagem: indisponivel.mensagem } }
    : {};
}

function periodoPublico(periodo) {
  return periodo ? { dateFrom: periodo.dateFrom, dateTo: periodo.dateTo, rotulo: periodo.rotulo || null } : null;
}

const CRITERIO = "Promoção disponível (que o anúncio ainda não está participando) que baixa o preço, avaliada pelo mesmo cálculo do simulador (LC por unidade, ΔLC, retorno ML, veredito). Ordem: veredito e, dentro dele, ΔLC × unidades vendidas no período (sem vendas, ΔLC por unidade). Comissão e frete são estimados do snapshot.";

// A promoção da linha com o GRUPO (ativa · participa · pode · ml) e a escrita que a Central suporta.
function comClasse(promocao, d) {
  const classe = classificarPromocao(
    { tipo: promocao.tipo, status: promocao.status, statusExibicao: promocao.statusExibicao },
    { tiposComEscrita: d.tiposComEscrita }
  );
  return { ...promocao, grupo: classe.grupo, escrita: classe.escrita };
}

// Linha do banco (promoção × snapshot) → candidata, com a mesma régua nas duas fontes.
function candidataDaLinha(r, promocao, vendasPorMlb, vendasIndisponivel, rebates, lista = {}) {
  return montarCandidata({
    listaFonte: lista.fonte || "promo_snapshot",
    listaObservadaEm: iso(lista.observadaEm || r.promo_observado_em),
    itemId: String(r.item_id),
    promocao,
    precoPromo: num(r.preco_promo),
    retornoMl: num(r.retorno) || 0,
    snap: {
      titulo: r.snap_titulo, image_url: r.image_url, price: r.price, cost: r.cost, tax_rate: r.tax_rate,
      fixed_fee: r.fixed_fee, commission_rate: r.commission_rate, freight: r.freight, margin: r.margin,
      commission: r.snap_commission, profit: r.snap_profit, snap_target_margin: r.snap_target_margin,
      anuncio_logistic_type: r.anuncio_logistic_type, list_price: r.snap_list_price,
    },
    precoOriginalPromo: num(r.promo_preco_original),
    titulo: r.fonte_titulo || null,
    vendasPorMlb,
    vendasIndisponivel,
    rebateAtual: rebates ? rebates.porItem.get(String(r.item_id)) || null : null,
    rebateIndisponivel: rebates ? rebates.indisponivel : null,
    rebatePromoSnapshot: rebates && rebates.porItem ? rebates.porItem.promoSnapshot : undefined,
  });
}

/**
 * Refina a PÁGINA já escolhida com a cotação REAL em P' (listing_prices +
 * shipping free, só GET): o recorte e a página vêm da estimativa; aqui só os
 * números e o veredito de cada linha passam a ser exatos. Cotação que falha
 * não some com a linha: ela vira `bloqueado` com o motivo (sem voltar à
 * estimativa). Dentro da página a ordem é refeita pelo mesmo critério.
 */
async function refinarPaginaAoVivo({ pagina, d, cliente, sellerId, ordem = null }) {
  const anuncios = await d.obterAnuncios(cliente.id, pagina.map((c) => c.itemId));
  let consultas = 0;
  const refinadas = await mapComLimite(pagina, 4, async (c) => {
    if (!c.__args) return c;
    const cotador = criarCotadorEmP({
      clienteId: cliente.id, itemId: c.itemId, anuncio: anuncios.get(c.itemId) || null, sellerId, mlUserId: sellerId,
      buscarComissaoEFrete: d.buscarComissaoEFrete, mlFetch: d.mlFetch, now: d.now, maxCotacoes: 1,
    });
    const cotacao = await cotador.cotar(c.precoPromocao);
    consultas += cotador.estatisticas().chamadas;
    const nova = montarCandidata({ ...c.__args, cotacaoReal: cotacao });
    return nova ? copiarCandidata(nova, { opcoes_total: c.opcoes_total, opcoes: c.opcoes }) : c;
  });
  refinadas.sort(comparadorDaOrdem(ordem));
  return { pagina: refinadas, consultas };
}

async function respostaDaLista({ base, candidatas, pag, veredito, tipo, busca = null, ordem = null, cotacao, d, cliente, sellerId }) {
  const ranking = rankearOportunidades(candidatas, { page: pag.page, limit: pag.limit, veredito, tipo, busca, ordem });
  let pagina = ranking.pagina;
  let consultas = 0;
  if (cotacao === "viva" && pagina.length) {
    const r = await refinarPaginaAoVivo({ pagina, d, cliente, sellerId, ordem });
    pagina = r.pagina;
    consultas = r.consultas;
  }
  return {
    ...base,
    page: pag.page,
    limit: pag.limit,
    total: ranking.total,
    hasNext: ranking.hasNext,
    filtro: { veredito: veredito === null ? "todos" : veredito, tipo, busca, ordem: ordem || "impacto" },
    contagem: ranking.contagem,
    resumo: ranking.resumo,
    tipos: ranking.tipos,
    cotacao: { modo: cotacao, consultas },
    oportunidades: pagina,
  };
}

// ─── Fonte principal: Promo Snapshot ─────────────────────────────────────────
async function oportunidadesDoSnapshot({ d, cliente, conta, sellerId, estado, sync, fontePromocoes, params, deps, pag, veredito, tipo, busca, ordem, cotacao }) {
  const { vendasPorMlb, periodo, indisponivel } = await carregarVendas(d, cliente, conta, params, deps);
  const { rows } = await d.promo.listarElegiveis({ clienteId: cliente.id, clienteContaId: conta.id, sellerId, runId: estado.snapshotRunId });
  // Retorno ML das promoções EM ANDAMENTO da conta — uma consulta (a margem
  // de hoje precisa dele para o ΔLC de qualquer anúncio da lista).
  const rebates = await carregarRebatesDaConta({ clienteContaId: conta.id, sellerId, db: d.db, promoRepo: deps.promoRepository, logger: deps.logger });
  const candidatas = rows.map((r) => candidataDaLinha(r, comClasse({
    // Mesma identidade do /simular (promotionId || chave): é o que o chip da worklist
    // entrega ao drawer para escolher a promoção na Bancada.
    id: r.promo_id || r.chave || null,
    chave: r.chave || null,
    nome: r.promo_nome || null,
    tipo: r.promo_tipo || null,
    status: String(r.promo_status || "").toLowerCase() || null,
    statusExibicao: r.promo_status_exibicao || null,
    precoFonte: r.promo_preco_fonte || null,
    fim: r.promo_fim || null,
    // Leitura desta promoção falhou no último run: é a última leitura boa.
    herdada: r.promo_herdado === true,
    observadaEm: r.promo_observado_em || null,
  }, d), vendasPorMlb, Boolean(indisponivel), rebates, { fonte: "promo_snapshot" })).filter(Boolean);
  return respostaDaLista({
    d, cliente, sellerId, tipo, busca, ordem, cotacao,
    base: {
      ok: true,
      disponivel: true,
      fonte: {
        tipo: "promo_snapshot",
        runId: estado.snapshotRunId,
        geradoEm: estado.snapshotAt,
        parcial: estado.partial === true,
        itensVarridos: num(estado.total),
        itensSemLeitura: estado.itemsWithoutRead || 0,
        itensHerdados: estado.itemsInherited || 0,
        ...frescor(estado.snapshotAt, d.now().getTime()),
      },
      sync,
      fontePromocoes,
      criterio: CRITERIO,
      periodo: periodoPublico(periodo),
      ...vendasPublico(indisponivel),
    },
    candidatas,
    pag,
    veredito,
  });
}

// ─── Compatibilidade: diagnóstico da tela antiga ─────────────────────────────
async function oportunidadesDoLegado({ d, cliente, conta, sellerId, diagnostico, sync, fontePromocoes, params, deps, pag, veredito, tipo, busca, ordem, cotacao }) {
  const diag = diagnostico;
  const base = {
    ok: true,
    disponivel: true,
    fonte: {
      tipo: "diagnostico_legado",
      diagnosticoId: Number(diag.id),
      geradoEm: diag.createdAt,
      parcial: diag.parcial === true,
      itensVarridos: num(diag.itensScaneados),
      ...frescor(diag.createdAt, d.now().getTime()),
    },
    sync,
    fontePromocoes,
    criterio: CRITERIO,
  };
  const { vendasPorMlb, periodo, indisponivel } = await carregarVendas(d, cliente, conta, params, deps);
  // Mesma consulta de elegíveis; status vem do payload da linha
  // (status || statusPromocao), vazio = aceito, como na tela antiga.
  const statusSql = STATUS_SQL;
  const { sql, params: valores } = sqlOportunidadesElegiveis({
    fonteSql: `
      SELECT i.item_id::text AS item_id, i.id::text AS chave, i.preco_promocao AS preco_promo, i.retorno_ml AS retorno,
             i.titulo AS fonte_titulo, i.campanha AS promo_nome, i.campanha_id AS promo_id,
             i.tipo_promocao AS promo_tipo, NULLIF(${statusSql}, '') AS promo_status, i.preco_original AS promo_preco_original
        FROM promocoes_diagnostico_itens i
       WHERE i.diagnostico_id = $1 AND i.item_id IS NOT NULL AND i.item_id <> ''
         AND i.preco_promocao IS NOT NULL AND i.preco_promocao > 0
         AND ${STATUS_ACEITOS_SQL}`,
    paramsFonte: [diag.id],
    clienteId: cliente.id,
    clienteContaId: conta.id,
  });
  const rows = lerLinhas(await d.db.query(sql, valores));
  const rebates = await carregarRebatesDaConta({ clienteContaId: conta.id, sellerId, db: d.db, promoRepo: deps.promoRepository, logger: deps.logger });
  const candidatas = rows.map((r) => candidataDaLinha(r, comClasse({
    id: r.promo_id || null, chave: r.chave || null, nome: r.promo_nome || null, tipo: r.promo_tipo || null, status: r.promo_status || null,
    // Diagnóstico antigo: preço e retorno da época do scan, não o estado de hoje no ML.
    estimativa: true,
  }, d), vendasPorMlb, Boolean(indisponivel), rebates, { fonte: "diagnostico_legado", observadaEm: diag.created_at })).filter(Boolean);
  return respostaDaLista({
    d, cliente, sellerId, tipo, busca, ordem, cotacao,
    base: { ...base, periodo: periodoPublico(periodo), ...vendasPublico(indisponivel) },
    candidatas,
    pag,
    veredito,
  });
}

async function listarOportunidades(params = {}, deps = {}) {
  const d = defaults(deps);
  // Filtro inválido recusa antes de qualquer leitura.
  const veredito = parseVeredito(params.veredito);
  const tipo = parseTipo(params.tipo);
  const busca = parseBusca(params.busca);
  const ordem = parseOrdem(params.ordem);
  const cotacao = parseCotacao(params.cotacao);
  const { cliente, conta } = await d.resolverContaDoCliente(
    { clienteSlug: params.clienteSlug, clienteContaId: params.clienteContaId },
    deps
  );
  const contaCompleta = await d.obterConta(conta.id, d.db);
  const sellerId = contaCompleta && contaCompleta.external_account_id ? String(contaCompleta.external_account_id) : null;
  const pag = {
    page: Math.max(1, Math.trunc(Number(params.page)) || 1),
    limit: Math.min(Math.max(Math.trunc(Number(params.limit)) || LIMITE_PADRAO, 1), LIMITE_MAX),
  };

  if (!sellerId) {
    return { ok: true, disponivel: false, motivo: "CONTA_SEM_GRANT_ML", mensagem: "A conta não tem conexão do Mercado Livre vinculada.", page: pag.page, limit: pag.limit, total: 0, hasNext: false, oportunidades: [] };
  }

  // Estado do Promo Snapshot (falha aqui não derruba a lista — cai no
  // legado/indisponível). Ler a lista NÃO enfileira varredura: abrir ou
  // trocar de aba nunca dispara scan. Quem atualiza é o orquestrador
  // (frescor/allowlist) ou o botão Atualizar da Central (POST /promocoes/sync).
  // `autoTrigger: true` explícito mantém o comportamento antigo para quem pedir.
  let estado = null;
  let sync = null;
  try {
    const r = await d.promo.estadoComAutoTrigger(
      { clienteId: cliente.id, clienteSlug: cliente.slug, clienteContaId: conta.id, marketplace: "meli", sellerId },
      { autoTrigger: params.autoTrigger === true }
    );
    estado = r.estado;
    sync = d.promo.syncPublico(r.estado, r.gatilho);
  } catch (err) {
    if (!(err && err.code === "42P01")) throw err;
  }

  // Fonte única: o legado só é consultado (e só entra no estado) se a conta NÃO tem snapshot.
  const temSnapshot = Boolean(estado && estado.hasSnapshot);
  const diagnostico = temSnapshot ? null : await obterDiagnosticoLegado({ db: d.db, clienteId: cliente.id, sellerId });
  const fontePromocoes = montarFontePromocoes({
    estado, config: resolvePromoSnapshotConfig(d.env), clienteSlug: cliente.slug, clienteContaId: conta.id, legado: diagnostico,
  });

  const ctx = { d, cliente, conta, sellerId, estado, diagnostico, sync, fontePromocoes, params, deps, pag, veredito, tipo, busca, ordem, cotacao };
  if (temSnapshot) return oportunidadesDoSnapshot(ctx);
  if (diagnostico) return oportunidadesDoLegado(ctx);

  return {
    ok: true,
    disponivel: false,
    motivo: "SEM_SNAPSHOT_PROMOCOES",
    // O mesmo texto da Bancada: o rótulo canônico da fonte única.
    mensagem: fontePromocoes.rotulo,
    sync,
    fontePromocoes,
    page: pag.page,
    limit: pag.limit,
    total: 0,
    hasNext: false,
    oportunidades: [],
  };
}

module.exports = {
  listarOportunidades,
  montarCandidata,
  rankearOportunidades,
  compararCandidatas,
  parseVeredito,
  parseTipo,
  parseBusca,
  parseOrdem,
  ORDENS,
  parseCotacao,
  motivoForaDoRanking,
  MOTIVO_FORA_DO_RANKING,
  VEREDITOS_PADRAO,
};
