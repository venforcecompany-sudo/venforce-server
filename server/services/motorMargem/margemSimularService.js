// server/services/motorMargem/margemSimularService.js
// POST /api/margem/simular — "e se este anúncio custasse P'?" para um MLB de
// uma conta, em vários cenários de uma vez.
//
// Uma fórmula só: o cálculo é o `core.calcularCenario` (que usa o
// computeMargin do Motor). Este serviço só monta as ENTRADAS, cada uma com
// fonte e data:
//   composição de hoje ... Margin Snapshot da conta (a mesma linha da tabela)
//                          + retorno ML da promoção em andamento (a mesma
//                          correção de leitura da tabela: margemAtualRebate)
//   promoções ............ Promo Snapshot da conta (P' = preço final do ML,
//                          retorno ML = subsídio, status bruto). Só se a conta
//                          NÃO tem snapshot: o diagnóstico legado da tela antiga,
//                          como ESTIMATIVA (promocao.estimativa = true; a tela
//                          não oferece Participar). `fontePromocoes` é o MESMO
//                          objeto que a aba Promoções devolve (fonte única).
//   comissão'/frete' ..... cotação REAL em P' (listing_prices / shipping
//                          free), uma por (MLB, P') por requisição
//   alíquota/custo/taxa .. do snapshot (Base)
// Cotação indisponível ⇒ `bloqueado` com motivo; NUNCA cai na taxa ou no
// frete atuais. Somente leitura: nada é escrito no Mercado Livre nem na Base.
//
// Escopo: usuário → cliente → cliente_conta_id → seller. A conta tem de estar
// na carteira do usuário (403) e o MLB tem de ser do seller dessa conta (403).

const pool = require("../../config/database");
const core = require("./core");
const { criarCotadorEmP, cotacaoParaNucleo, evidenciaDaCotacao } = require("./margemCotacaoEmP");
const { carregarRebatesAtivos, margemAtualComRebate, MOTIVO_REBATE } = require("./margemAtualRebate");
const { classificarPromocao, urlPromocoesMl } = require("./precificacao/promocaoClassificacao");
const { resolvePromoSnapshotConfig } = require("../promoSnapshot/promoSnapshotConfig");
const { montarFontePromocoes } = require("../promoSnapshot/promoSnapshotFonte");
const legadoPromo = require("../promoSnapshot/promoSnapshotLegado");

const MAX_CENARIOS = 20;
const MAX_PROMOS_POR_ITEM = 60;
const MAX_COTACOES_POR_REQUISICAO = 40;
const TIPOS = new Set(["preco", "promo", "todas_promos", "insumos", "preco_alvo"]);
const MAX_ITERACOES_PRECO_ALVO = 8;
const CAMPOS_INSUMOS = ["preco", "custo", "aliquota", "taxa_fixa", "comissao", "frete", "rebate"];

function erroHttp(statusCode, codigo, motivo, extra = {}) {
  const err = new Error(motivo);
  err.statusCode = statusCode;
  err.code = codigo;
  err.payload = { ok: false, codigo, code: codigo, erro: motivo, motivo, ...extra };
  return err;
}

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function iso(valor) {
  if (!valor) return null;
  const d = valor instanceof Date ? valor : new Date(valor);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function defaults(deps = {}) {
  return {
    db: deps.db || pool,
    now: deps.now || (() => new Date()),
    logger: deps.logger || console,
    env: deps.env || process.env,
    assertContaNaCarteira:
      deps.assertContaNaCarteira || require("../squads/authorizationService").assertClienteContaNaCarteira,
    obterConta: deps.obterConta || require("../clienteContas/clienteContaService").obterConta,
    snapshotRepo: deps.snapshotRepo || require("./marginSnapshotRepository"),
    obterAnuncio: deps.obterAnuncio || ((clienteId, itemId) => require("../meliAnuncios/meliAnunciosService").obterAnuncio(clienteId, itemId)),
    promoService: deps.promoService || require("../promoSnapshot/promoSnapshotService"),
    promoRepo: deps.promoRepo || require("../promoSnapshot/promoSnapshotRepository"),
    promoLegado: deps.promoLegado || legadoPromo,
    buscarComissaoEFrete: deps.buscarComissaoEFrete || require("../shared/marketplaceCurrentQuoteService").buscarComissaoEFrete,
    mlFetch: deps.mlFetch || require("../../utils/mlClient").mlFetch,
    carregarRebates: deps.carregarRebates || carregarRebatesAtivos,
    // Tipos de promoção que a camada segura da Central escreve (decide o grupo e a ação).
    tiposComEscrita: deps.tiposComEscrita || null,
    obterBaseNome: deps.obterBaseNome || ((baseId, db) => consultarNomeDaBase(baseId, db)),
  };
}

// Nome da Base de custos do snapshot (só o rótulo do topo da Bancada: "Base Red Fish").
async function consultarNomeDaBase(baseId, db) {
  if (!db || typeof db.query !== "function") return null;
  const r = await db.query("SELECT nome FROM bases WHERE id = $1", [baseId]);
  return r.rows && r.rows[0] ? r.rows[0].nome || null : null;
}

// Base do snapshot com o nome; sem nome (falha da leitura ou base apagada) fica só o id — nunca derruba o /simular.
async function baseDoSnapshot(snapshot, d) {
  const baseId = snapshot ? num(snapshot.baseId) : null;
  if (baseId === null) return null;
  try {
    return { id: baseId, nome: (await d.obterBaseNome(baseId, d.db)) || null };
  } catch (err) {
    if (d.logger && d.logger.warn) d.logger.warn("[margemSimular] nome da Base indisponível", { baseId, erro: err.message });
    return { id: baseId, nome: null };
  }
}

// ─── Validação do corpo (400 explícito: nada é ignorado em silêncio) ─────────

function parseInteiroPositivo(bruto) {
  if (bruto === null || bruto === undefined || String(bruto).trim() === "") return null;
  const n = Number(bruto);
  return Number.isInteger(n) && n > 0 ? n : NaN;
}

// Preço digitado: número > 0 com no máximo 2 casas. Nunca arredonda em
// silêncio ("114,999" é recusado, não vira 115,00).
function validarPrecoCenario(bruto, indice) {
  if (bruto === null || bruto === undefined || bruto === "") {
    throw erroHttp(400, "PRECO_AUSENTE", `cenarios[${indice}].preco é obrigatório.`);
  }
  const texto = String(bruto).trim().replace(",", ".");
  const n = Number(texto);
  if (!Number.isFinite(n) || n <= 0) {
    throw erroHttp(400, "PRECO_INVALIDO", `cenarios[${indice}].preco precisa ser um número maior que zero.`);
  }
  if (!/^\d+(\.\d{1,2})?$/.test(texto)) {
    throw erroHttp(400, "PRECO_CASAS_DECIMAIS", `cenarios[${indice}].preco aceita no máximo duas casas decimais.`);
  }
  return core.round2(n);
}

function validarInsumos(bruto, indice) {
  if (!bruto || typeof bruto !== "object" || Array.isArray(bruto)) {
    throw erroHttp(400, "INSUMOS_INVALIDOS", `cenarios[${indice}].insumos precisa ser um objeto.`);
  }
  const saida = {};
  for (const campo of Object.keys(bruto)) {
    if (!CAMPOS_INSUMOS.includes(campo)) {
      throw erroHttp(400, "INSUMOS_CAMPO_DESCONHECIDO", `cenarios[${indice}].insumos.${campo} não é um insumo aceito (${CAMPOS_INSUMOS.join(", ")}).`);
    }
    const valor = bruto[campo];
    if (valor === null) { saida[campo] = null; continue; }
    const n = typeof valor === "string" ? Number(valor.trim().replace(",", ".")) : Number(valor);
    if (valor === "" || !Number.isFinite(n)) {
      throw erroHttp(400, "INSUMOS_VALOR_INVALIDO", `cenarios[${indice}].insumos.${campo} precisa ser um número (ou null).`);
    }
    saida[campo] = n;
  }
  return saida;
}

// Hipótese de custo (`hipotese: { custo, taxa_fixa }`) num cenário de preço ou promoção: o
// operador testa "e se o custo fosse X?" sem mexer na Base. Ausente = os custos reais.
// Valor inválido é 400 (nada é ignorado em silêncio). A escrita nunca usa hipótese.
const CAMPOS_HIPOTESE = ["custo", "taxa_fixa"];
function hipoteseDe(c, indice) {
  if (c.hipotese === undefined || c.hipotese === null) return {};
  if (typeof c.hipotese !== "object" || Array.isArray(c.hipotese)) {
    throw erroHttp(400, "HIPOTESE_INVALIDA", `cenarios[${indice}].hipotese precisa ser um objeto.`);
  }
  const saida = {};
  for (const campo of Object.keys(c.hipotese)) {
    if (!CAMPOS_HIPOTESE.includes(campo)) {
      throw erroHttp(400, "HIPOTESE_CAMPO_DESCONHECIDO", `cenarios[${indice}].hipotese.${campo} não é aceito (${CAMPOS_HIPOTESE.join(", ")}).`);
    }
    const valor = c.hipotese[campo];
    const n = typeof valor === "string" ? Number(valor.trim().replace(",", ".")) : Number(valor);
    if (valor === null || valor === "" || !Number.isFinite(n) || n < 0) {
      throw erroHttp(400, "HIPOTESE_VALOR_INVALIDO", `cenarios[${indice}].hipotese.${campo} precisa ser um número maior ou igual a zero.`);
    }
    saida[campo] = n;
  }
  return Object.keys(saida).length ? { hipotese: saida } : {};
}

function validarCorpo(body) {
  const b = body && typeof body === "object" ? body : {};
  const contaId = parseInteiroPositivo(b.cliente_conta_id ?? b.clienteContaId);
  if (contaId === null) throw erroHttp(400, "CLIENTE_CONTA_ID_OBRIGATORIO", "cliente_conta_id é obrigatório: a simulação é sempre por conta.");
  if (Number.isNaN(contaId)) throw erroHttp(400, "CLIENTE_CONTA_ID_INVALIDO", "cliente_conta_id inválido.");

  const mlb = String(b.mlb || "").trim().toUpperCase();
  if (!/^MLB\d+$/.test(mlb)) throw erroHttp(400, "MLB_INVALIDO", "Informe um anúncio (MLB) válido.");

  if (!Array.isArray(b.cenarios) || b.cenarios.length === 0) {
    throw erroHttp(400, "CENARIOS_OBRIGATORIOS", "Informe ao menos um cenário em `cenarios`.");
  }
  if (b.cenarios.length > MAX_CENARIOS) {
    throw erroHttp(400, "CENARIOS_DEMAIS", `No máximo ${MAX_CENARIOS} cenários por requisição.`, { maximo: MAX_CENARIOS });
  }

  const cenarios = b.cenarios.map((c, i) => {
    if (!c || typeof c !== "object") throw erroHttp(400, "CENARIO_INVALIDO", `cenarios[${i}] precisa ser um objeto.`);
    const tipo = String(c.tipo || "").trim().toLowerCase();
    if (!TIPOS.has(tipo)) {
      throw erroHttp(400, "CENARIO_TIPO_INVALIDO", `cenarios[${i}].tipo precisa ser: ${Array.from(TIPOS).join(", ")}.`);
    }
    if (tipo === "preco") return { tipo, preco: validarPrecoCenario(c.preco, i), ...hipoteseDe(c, i) };
    if (tipo === "promo") {
      const id = String(c.promotion_id ?? "").trim();
      if (!id || id.length > 160) throw erroHttp(400, "PROMOTION_ID_OBRIGATORIO", `cenarios[${i}].promotion_id é obrigatório.`);
      return { tipo, promotion_id: id, ...hipoteseDe(c, i) };
    }
    if (tipo === "insumos") return { tipo, insumos: validarInsumos(c.insumos, i) };
    if (tipo === "preco_alvo") {
      if (c.margem_alvo === undefined || c.margem_alvo === null) return { tipo, margem_alvo: null };
      const meta = Number(c.margem_alvo);
      if (!Number.isFinite(meta) || meta <= 0 || meta >= 1) {
        throw erroHttp(400, "MARGEM_ALVO_INVALIDA", `cenarios[${i}].margem_alvo precisa ser uma fração entre 0 e 1 (ex.: 0,10 = 10%).`);
      }
      return { tipo, margem_alvo: meta };
    }
    return { tipo };
  });
  return { contaId, mlb, cenarios };
}

// ─── Escopo e dados do item ──────────────────────────────────────────────────

async function autorizarConta(user, contaId, d) {
  // 404 (conta inexistente) / 403 (cliente fora da carteira) — mesmo contrato
  // do guard de carteira das demais rotas.
  const autorizada = await d.assertContaNaCarteira(user || {}, contaId, d.db);
  const conta = await d.obterConta(contaId, d.db);
  if (Number(conta.cliente_id) !== Number(autorizada.clienteId)) {
    throw erroHttp(403, "CONTA_NAO_PERTENCE_AO_CLIENTE", "Esta conta não pertence ao cliente.");
  }
  if (String(conta.marketplace || "").toLowerCase() !== "meli") {
    throw erroHttp(422, "MARKETPLACE_INCOMPATIVEL", "A simulação só atende contas Mercado Livre.");
  }
  if (conta.ativo === false) throw erroHttp(409, "CONTA_INATIVA", `A conta "${conta.nome}" foi desativada.`);
  return { autorizada, conta };
}

async function resolverEscopo(user, contaId, d) {
  const { autorizada, conta } = await autorizarConta(user, contaId, d);
  const sellerId = conta.external_account_id ? String(conta.external_account_id) : null;
  if (!sellerId) throw erroHttp(422, "CONTA_SEM_GRANT_ML", "A conta não tem conexão do Mercado Livre vinculada.");
  return {
    clienteId: Number(autorizada.clienteId),
    clienteSlug: autorizada.clienteSlug || null,
    conta: { id: Number(conta.id), nome: conta.nome || null },
    sellerId,
  };
}

async function carregarItem(escopo, mlb, d) {
  const [snapshot, anuncio] = await Promise.all([
    d.snapshotRepo.getProjectionSnapshot({ clienteContaId: escopo.conta.id, itemId: mlb, db: d.db }),
    d.obterAnuncio(escopo.clienteId, mlb),
  ]);
  const dono = anuncio && anuncio.ml_user_id ? String(anuncio.ml_user_id) : null;
  if (dono && dono !== escopo.sellerId) {
    throw erroHttp(403, "MLB_FORA_DA_CONTA", "Este anúncio não pertence ao seller da conta informada.");
  }
  if (!snapshot && !anuncio) throw erroHttp(404, "MLB_NAO_ENCONTRADO", "Anúncio não encontrado para esta conta.");
  return { snapshot, anuncio };
}

function metaDoSnapshot(snapshot) {
  const bruta = snapshot && snapshot.quality ? num(snapshot.quality.targetMargin) : null;
  if (bruta !== null && bruta > 0 && bruta < 1) return { margem_alvo: bruta, margem_minima: 0, fonte: "margin_snapshot" };
  // Meta não informada (ou inválida no snapshot): o padrão do Motor, dito como padrão.
  return { margem_alvo: core.DEFAULT_TARGET_MARGIN, margem_minima: 0, fonte: "padrao_do_motor", motivo: bruta === null ? "meta_nao_informada" : "meta_fora_da_faixa" };
}

async function carregarPromocoes(escopo, mlb, d, estado, diagnostico = null) {
  if (!estado || !estado.hasSnapshot) {
    // Fonte única: sem snapshot, o diagnóstico legado (se existir) entra como ESTIMATIVA.
    if (diagnostico) {
      const linhas = await d.promoLegado.listarPromocoesLegadoDoItem({ db: d.db, diagnostico, itemId: mlb, limit: MAX_PROMOS_POR_ITEM });
      return { disponivel: true, motivo: null, linhas, estado, origem: "diagnostico_legado", diagnostico };
    }
    return { disponivel: false, motivo: core.MOTIVOS.SEM_SNAPSHOT_PROMOCOES, linhas: [], estado, origem: null, diagnostico: null };
  }
  const { linhas } = await d.promoRepo.listarLinhasSnapshot({
    clienteContaId: escopo.conta.id, sellerId: escopo.sellerId, runId: estado.snapshotRunId,
    page: 1, limit: MAX_PROMOS_POR_ITEM, itemId: mlb,
  }, d.db);
  return { disponivel: true, motivo: null, linhas, estado, origem: "promo_snapshot", diagnostico: null };
}

function promocaoPublica(linha, opcoes = {}) {
  const classe = classificarPromocao(
    { tipo: linha.tipo, status: linha.status, statusExibicao: linha.statusExibicao },
    { tiposComEscrita: opcoes.tiposComEscrita || null }
  );
  return {
    id: linha.promotionId || linha.promocaoChave,
    chave: linha.promocaoChave,
    ref_id: linha.refId || null,
    tipo: linha.tipo || null,
    nome: linha.nome || null,
    status: linha.status || null,
    status_exibicao: linha.statusExibicao || null,
    inicio: iso(linha.inicio),
    fim: iso(linha.fim),
    preco_original: linha.precoOriginal,
    preco_final: linha.precoFinal,
    preco_final_fonte: linha.precoFinalFonte || null,
    desconto_percentual: linha.descontoPercentual,
    seller_percentage: linha.sellerPercentage,
    meli_percentage: linha.meliPercentage,
    subsidio_ml: linha.subsidioMl,
    elegivel: linha.elegivel === true,
    observado_em: iso(linha.observedAt),
    herdada: linha.herdada === true,
    // Em que grupo a promoção aparece e o que a Central consegue fazer com ela.
    grupo: classe.grupo,
    escrita: classe.escrita,
    // Diagnóstico legado = estimativa: sem leitura de hoje no ML, a Bancada não oferece Participar.
    estimativa: linha.estimativa === true,
    fonte: linha.estimativa === true ? "diagnostico_legado" : "promo_snapshot",
  };
}

function casaPromocao(linha, id) {
  const alvo = String(id);
  return String(linha.promocaoChave) === alvo || String(linha.promotionId || "") === alvo || String(linha.refId || "") === alvo;
}

// Preço CHEIO (sem promoção) do anúncio, para o "quem banca": o do item
// (`list_price` do Margin Snapshot = regular_amount do sale_price) e, só se o
// item não o tem, o `original_price` da própria promoção. A fonte é dita na
// resposta; sem nenhum dos dois o núcleo devolve banca nula com
// `sem_preco_cheio` — nunca o preço atual (que já pode ser promocional).
function resolverPrecoCheio(snapshot, promocao) {
  const doItem = snapshot ? num(snapshot.listPrice) : null;
  if (doItem !== null && doItem > 0) return { valor: doItem, fonte: "margin_snapshot" };
  const daPromo = promocao ? num(promocao.preco_original) : null;
  if (daPromo !== null && daPromo > 0) return { valor: daPromo, fonte: "promo_snapshot" };
  return { valor: null, fonte: null };
}

// ─── Montagem dos cenários ───────────────────────────────────────────────────

// Cada pedido vira 1+ "tarefas" (todas_promos expande). A tarefa diz o que o
// núcleo precisa: P', retorno ML, status da promoção — ou um bloqueio que nem
// chega ao cálculo (sem Promo Snapshot, promoção inexistente).
function montarTarefas(pedidos, promocoes, opcoes = {}) {
  const tarefas = [];
  const bloqueio = (tipo, entrada, motivo, extra = {}) => tarefas.push({ tipo, entrada, bloqueio: motivo, ...extra });

  for (const pedido of pedidos) {
    if (pedido.tipo === "preco") {
      tarefas.push({ tipo: "preco", entrada: { preco: pedido.preco, ...(pedido.hipotese ? { hipotese: pedido.hipotese } : {}) }, preco: pedido.preco, rebate: 0, hipotese: pedido.hipotese || null });
    } else if (pedido.tipo === "insumos") {
      tarefas.push({ tipo: "insumos", entrada: { insumos: pedido.insumos }, insumos: pedido.insumos });
    } else if (pedido.tipo === "preco_alvo") {
      tarefas.push({ tipo: "preco_alvo", entrada: { margem_alvo: pedido.margem_alvo }, margem_alvo: pedido.margem_alvo });
    } else if (pedido.tipo === "promo") {
      const entrada = { promotion_id: pedido.promotion_id, ...(pedido.hipotese ? { hipotese: pedido.hipotese } : {}) };
      if (!promocoes.disponivel) { bloqueio("promo", entrada, core.MOTIVOS.SEM_SNAPSHOT_PROMOCOES); continue; }
      const casadas = promocoes.linhas.filter((l) => casaPromocao(l, pedido.promotion_id));
      if (casadas.length === 0) { bloqueio("promo", entrada, core.MOTIVOS.PROMOCAO_NAO_ENCONTRADA); continue; }
      if (casadas.length > 1) { bloqueio("promo", entrada, core.MOTIVOS.PROMOCAO_AMBIGUA); continue; }
      tarefas.push({ ...tarefaDePromocao(casadas[0], entrada, opcoes), hipotese: pedido.hipotese || null });
    } else {
      // todas_promos
      if (!promocoes.disponivel) { bloqueio("promo", { promotion_id: null }, core.MOTIVOS.SEM_SNAPSHOT_PROMOCOES); continue; }
      for (const linha of promocoes.linhas) tarefas.push(tarefaDePromocao(linha, { promotion_id: linha.promotionId || linha.promocaoChave, origem: "todas_promos" }, opcoes));
    }
  }
  return tarefas;
}

function tarefaDePromocao(linha, entrada, opcoes = {}) {
  const subsidio = num(linha.subsidioMl);
  return {
    tipo: "promo",
    entrada,
    promocao: promocaoPublica(linha, opcoes),
    preco: num(linha.precoFinal),
    // ML não informou retorno (meli_percentage ausente) = a promoção é do
    // seller; vira 0 DECLARADO na evidência, não um zero escondido.
    rebate: subsidio === null ? 0 : subsidio,
    rebate_informado: subsidio !== null,
    status_promocao: linha.status || null,
    // statusExibicao ATIVA = a promoção FORMA o preço de hoje (grupo "ativa"
    // dos Anúncios). Raw status started/active também cobre "participa"
    // (inscrita, NÃO APLICADA) — nunca usar o status bruto pra essa decisão.
    status_exibicao: linha.statusExibicao || null,
  };
}

// Promoção que já forma o preço de hoje (statusExibicao ATIVA): o núcleo
// responde com a composição de hoje sem cotação nova — ou P' ≥ preço atual,
// que não baixa o preço. Não gasta consulta ao ML à toa.
function deveCotar(tarefa, atual) {
  if (tarefa.bloqueio || tarefa.tipo === "insumos" || tarefa.tipo === "preco_alvo") return false;
  if (!(tarefa.preco !== null && tarefa.preco > 0)) return false;
  if (tarefa.tipo !== "promo") return true;
  if (String(tarefa.status_exibicao || "").toUpperCase() === "ATIVA") return false;
  const precoAtual = num(atual.preco);
  return !(precoAtual !== null && tarefa.preco >= precoAtual - core.TOLERANCIA_VALOR);
}

const evidenciaCotacao = evidenciaDaCotacao;

// Campos de preço cheio de um cenário (vão para o núcleo) a partir do contexto.
function evidenciaPrecoCheio(ctx, promocao) {
  const r = resolverPrecoCheio(ctx.snapshot, promocao);
  if (r.valor === null) return { fonte: null, motivo: "sem_preco_cheio" };
  return r.fonte === "margin_snapshot"
    ? { fonte: r.fonte, calculado_em: ctx.snapshotCalculadoEm || null }
    : { fonte: r.fonte, observado_em: promocao ? promocao.observado_em : null };
}

function precoCheioDoCenario(ctx, promocao) {
  const r = resolverPrecoCheio(ctx.snapshot, promocao);
  return { preco_cheio: r.valor, preco_cheio_fonte: r.fonte };
}

function calcularTarefa(tarefa, ctx) {
  const { atual, flags, meta, cotacoes, evidenciaBase, rebateAtual } = ctx;
  const saidaBase = { tipo: tarefa.tipo, entrada: tarefa.entrada };
  if (tarefa.promocao) saidaBase.promocao = tarefa.promocao;

  if (tarefa.bloqueio) {
    return { ...saidaBase, ...core.resultadoBloqueado(tarefa.bloqueio, { flags, meta }), evidencia: null };
  }

  if (tarefa.tipo === "insumos") {
    const ins = tarefa.insumos;
    const pick = (campo, fallback) => (Object.prototype.hasOwnProperty.call(ins, campo) ? ins[campo] : fallback);
    const resultado = core.calcularCenario({
      atual,
      cenario: {
        tipo: "insumos",
        preco: pick("preco", atual.preco),
        rebate: pick("rebate", atual.rebate),
        custo: pick("custo", atual.custo),
        aliquota: pick("aliquota", atual.aliquota),
        taxa_fixa: pick("taxa_fixa", atual.taxa_fixa),
        ...precoCheioDoCenario(ctx, null),
      },
      // Hipótese do operador: comissão e frete são os informados (ou os de hoje); não há recotação.
      cotacao: { comissao: pick("comissao", atual.comissao), frete: pick("frete", atual.frete), frete_aplicavel: ctx.freteAplicavel },
      meta,
      flags,
    });
    return {
      ...saidaBase,
      ...resultado,
      evidencia: { ...evidenciaBase, preco: { fonte: "informado", consultado_em: null }, preco_cheio: evidenciaPrecoCheio(ctx, null), hipotese: true },
    };
  }

  const cotacao = deveCotar(tarefa, atual) ? cotacoes.get(Number(tarefa.preco).toFixed(2)) || null : null;
  const resultado = core.calcularCenario({
    atual,
    cenario: { tipo: tarefa.tipo, preco: tarefa.preco, rebate: tarefa.rebate, status_promocao: tarefa.status_promocao, status_exibicao: tarefa.status_exibicao, ...precoCheioDoCenario(ctx, tarefa.promocao), ...(tarefa.hipotese || {}) },
    cotacao: cotacao
      ? cotacaoParaNucleo(cotacao)
      : { comissao: null, frete: null, frete_aplicavel: ctx.freteAplicavel },
    meta,
    flags,
  });
  const evidencia = { ...evidenciaBase, ...(evidenciaCotacao(cotacao) || {}), preco_cheio: evidenciaPrecoCheio(ctx, tarefa.promocao) };
  if (tarefa.hipotese) {
    // Custo/taxa fixa informados pelo operador: hipótese dita na evidência (nunca passa por dado da Base).
    for (const campo of Object.keys(tarefa.hipotese)) evidencia[campo === "custo" ? "custo" : "taxa_fixa"] = { fonte: "hipotese_do_operador", valor: tarefa.hipotese[campo] };
    evidencia.hipotese = true;
  }
  if (tarefa.tipo === "promo") {
    evidencia.preco = { fonte: tarefa.promocao.fonte, observado_em: tarefa.promocao.observado_em, fonte_do_preco: tarefa.promocao.preco_final_fonte };
    evidencia.rebate = {
      fonte: tarefa.promocao.fonte,
      observado_em: tarefa.promocao.observado_em,
      informado: tarefa.rebate_informado === true,
      motivo: tarefa.rebate_informado === true ? null : "ml_nao_informou_retorno",
    };
  } else {
    evidencia.preco = { fonte: "informado", consultado_em: null };
  }
  // Sem a atualidade da composição de hoje, a faixa de frete seria só uma
  // comparação sem data: ela vem sempre acompanhada de `evidencia.atual`.
  return { ...saidaBase, ...resultado, evidencia, _rebateAtual: rebateAtual };
}

const ceil2 = (v) => Math.ceil(v * 100 - 1e-9) / 100;

/**
 * "Subir p/ R$ X": o MENOR preço que atinge a margem alvo, com a cotação REAL
 * (comissão e frete do Mercado Livre em cada preço tentado). Iteração de ponto
 * fixo sobre o `core.proximoPrecoAlvo` (a conta é a do computeTargetPrice) até o
 * preço parar de subir; cada preço tentado é UMA cotação (cache por requisição,
 * dentro do teto). Sem preço que atinja a meta em até 8 passos, meta inviável ou
 * dado ausente: `sem_preco_viavel` — nunca um chute. O preço também DESCE quando
 * a cotação mostra que há folga (frete que cai de faixa): devolve o menor preço
 * viável encontrado, sem garantia de mínimo global através de saltos de faixa.
 */
async function resolverPrecoAlvo(tarefa, ctx) {
  const { atual, flags, meta, cotador, evidenciaBase } = ctx;
  const metaAlvo = tarefa.margem_alvo === null || tarefa.margem_alvo === undefined ? meta.margem_alvo : tarefa.margem_alvo;
  const metaUsada = { ...meta, margem_alvo: metaAlvo };
  const saida = { tipo: "preco_alvo", entrada: tarefa.entrada };
  const precosTentados = [];
  const semPreco = (motivo, extra = {}) => ({
    ...saida,
    ...core.resultadoBloqueado(motivo, { flags, meta: metaUsada }),
    preco_alvo: { encontrado: false, preco: null, motivo, margem_alvo: metaAlvo, iteracoes: precosTentados.length, precos_tentados: precosTentados.slice(), ...extra },
    evidencia: null,
  });

  const atualCalc = core.calcularAtual({ atual, frete_aplicavel: ctx.freteAplicavel });
  if (atualCalc.bloqueios.length) return semPreco(atualCalc.bloqueios[0]);
  if (flags.rebate_ambiguo || flags.rebate_atual_indisponivel) {
    return semPreco(flags.rebate_ambiguo ? core.MOTIVOS.REBATE_AMBIGUO : core.MOTIVOS.REBATE_ATUAL_INDISPONIVEL);
  }
  const insumos = { custo: atual.custo, taxa_fixa: atual.taxa_fixa, aliquota: atual.aliquota, margem_alvo: metaAlvo };
  let passo = core.proximoPrecoAlvo({ ...insumos, preco: atual.preco, comissao: atual.comissao, frete: atual.frete === null || atual.frete === undefined ? 0 : atual.frete });
  if (!passo.ok) return semPreco(core.MOTIVOS.SEM_PRECO_VIAVEL, { causa: passo.motivo });
  let preco = ceil2(passo.preco);
  const inicial = preco;
  let melhor = null;

  for (let i = 1; i <= MAX_ITERACOES_PRECO_ALVO; i += 1) {
    precosTentados.push(preco);
    const cotacao = await cotador.cotar(preco);
    const cen = core.calcularCenario({
      atual,
      cenario: { tipo: "preco", preco, ...precoCheioDoCenario(ctx, null) },
      cotacao: cotacaoParaNucleo(cotacao),
      meta: metaUsada,
      flags,
    });
    // Cotação que falta (ou teto de cotações): o motivo é o dela, sem estimar.
    if (cen.cenario.margem_ratio === null) {
      if (melhor) break;
      return { ...saida, ...cen, atual: undefined, preco_alvo: { encontrado: false, preco: null, motivo: cen.motivo, margem_alvo: metaAlvo, iteracoes: i, precos_tentados: precosTentados.slice(), inicial }, evidencia: evidenciaDaCotacao(cotacao) };
    }
    const viavel = cen.cenario.margem_ratio >= metaAlvo && cen.cenario.lc > 0;
    if (viavel && (!melhor || preco < melhor.preco)) melhor = { preco, cen, cotacao, iteracoes: i };
    passo = core.proximoPrecoAlvo({ ...insumos, preco, comissao: cotacao.comissao, frete: cotacao.frete === null ? 0 : cotacao.frete });
    if (!passo.ok) { if (melhor) break; return semPreco(core.MOTIVOS.SEM_PRECO_VIAVEL, { causa: passo.motivo }); }
    const alvoDaCotacao = ceil2(passo.preco);
    let proximo;
    if (viavel) {
      // Há folga? Só desce se a cotação deste preço indica um preço menor e ainda não tentado.
      if (alvoDaCotacao >= preco - 0.005) break;
      proximo = alvoDaCotacao;
    } else {
      // A margem ficou abaixo da meta: sempre sobe.
      proximo = Math.max(alvoDaCotacao, Math.round((preco + 0.01) * 100) / 100);
    }
    if (precosTentados.includes(proximo)) break;
    preco = proximo;
  }
  if (!melhor) return semPreco(core.MOTIVOS.SEM_PRECO_VIAVEL, { causa: "sem_convergencia", inicial });
  const resultado = {
    ...saida,
    ...melhor.cen,
    preco_alvo: { encontrado: true, preco: melhor.preco, motivo: null, margem_alvo: metaAlvo, iteracoes: precosTentados.length, precos_tentados: precosTentados.slice(), inicial },
    evidencia: { ...evidenciaBase, ...(evidenciaDaCotacao(melhor.cotacao) || {}), preco: { fonte: "busca_preco_alvo", meta_fonte: meta.fonte } },
  };
  delete resultado.atual;
  return resultado;
}

/**
 * @param {{ user: object, body: object }} p
 * @param {object} [deps]
 */
async function simular({ user, body } = {}, deps = {}) {
  const d = defaults(deps);
  const pedido = validarCorpo(body);
  const escopo = await resolverEscopo(user, pedido.contaId, d);
  const { snapshot, anuncio } = await carregarItem(escopo, pedido.mlb, d);

  const agora = d.now();
  const geradoEm = agora.toISOString();
  const semSnapshot = !snapshot || Boolean(snapshot.catalogMissingSince);

  // ── Composição de hoje: a mesma da tabela (snapshot + retorno ML em andamento) ──
  let rebates = { porItem: new Map(), indisponivel: null };
  if (!semSnapshot) {
    rebates = await d.carregarRebates({
      clienteContaId: escopo.conta.id, sellerId: escopo.sellerId, itemIds: [pedido.mlb], db: d.db, promoRepo: d.promoRepo, logger: d.logger,
    });
  }
  const infoRebate = rebates.porItem.get(pedido.mlb);
  const atualRebate = semSnapshot
    ? { rebate: null, rebateMotivo: null }
    : margemAtualComRebate(snapshot, infoRebate, rebates.indisponivel);

  const cotador = criarCotadorEmP({
    clienteId: escopo.clienteId,
    itemId: pedido.mlb,
    anuncio,
    sellerId: escopo.sellerId,
    mlUserId: escopo.sellerId,
    buscarComissaoEFrete: d.buscarComissaoEFrete,
    mlFetch: d.mlFetch,
    now: d.now,
    maxCotacoes: MAX_COTACOES_POR_REQUISICAO,
    timeoutMs: deps.mlTimeoutMs || 8000,
  });

  const atual = semSnapshot
    ? { sem_snapshot: true }
    : {
        preco: snapshot.price,
        custo: snapshot.cost,
        aliquota: snapshot.taxRate,
        taxa_fixa: snapshot.fixedFee,
        comissao: snapshot.commission,
        frete: snapshot.freight,
        rebate: atualRebate.rebate === null ? 0 : atualRebate.rebate,
      };
  const meta = metaDoSnapshot(snapshot);
  const flags = {
    rebate_ambiguo: atualRebate.rebateMotivo === MOTIVO_REBATE.AMBIGUO,
    rebate_atual_indisponivel: atualRebate.rebateMotivo === MOTIVO_REBATE.PROMO_SNAPSHOT_INDISPONIVEL,
  };

  // ── Promoções (só lê o Promo Snapshot quando algum cenário precisa) ──
  const precisaPromo = pedido.cenarios.some((c) => c.tipo === "promo" || c.tipo === "todas_promos");
  // Estado do Promo Snapshot (data do snapshot): para as promoções pedidas e
  // para dar data ao retorno ML que já compõe a margem de hoje.
  const estadoPromo = precisaPromo || atualRebate.rebate !== null
    ? await d.promoService.estadoSincronizacao(
      { clienteContaId: escopo.conta.id, marketplace: "meli", sellerId: escopo.sellerId },
      { db: d.db, repo: d.promoRepo, now: d.now, env: d.env, logger: d.logger }
    )
    : null;
  // Fonte única: o legado só é consultado se a conta NÃO tem snapshot.
  const diagnosticoLegado = precisaPromo && !(estadoPromo && estadoPromo.hasSnapshot)
    ? await d.promoLegado.obterDiagnosticoLegado({ db: d.db, clienteId: escopo.clienteId, sellerId: escopo.sellerId })
    : null;
  const promocoes = precisaPromo
    ? await carregarPromocoes(escopo, pedido.mlb, d, estadoPromo, diagnosticoLegado)
    : { disponivel: null, motivo: null, linhas: [], estado: null, origem: null, diagnostico: null };
  const fontePromocoes = precisaPromo
    ? montarFontePromocoes({ estado: estadoPromo, config: resolvePromoSnapshotConfig(d.env), clienteSlug: escopo.clienteSlug, legado: diagnosticoLegado })
    : null;

  const tarefas = montarTarefas(pedido.cenarios, promocoes, { tiposComEscrita: d.tiposComEscrita });

  // ── Cotação em P' — só dos preços distintos que as tarefas pedem ──
  const precosParaCotar = semSnapshot ? [] : tarefas.filter((t) => deveCotar(t, atual)).map((t) => t.preco);
  const cotacoes = await cotador.cotarVarios(precosParaCotar);

  const evidenciaBase = semSnapshot
    ? {}
    : {
        custo: { fonte: "margin_snapshot", calculado_em: iso(snapshot.calculatedAt), base_id: snapshot.baseId },
        aliquota: { fonte: "margin_snapshot", calculado_em: iso(snapshot.calculatedAt), base_id: snapshot.baseId },
        taxa_fixa: { fonte: "margin_snapshot", calculado_em: iso(snapshot.calculatedAt), base_id: snapshot.baseId },
      };

  const ctx = {
    atual, flags, meta, cotacoes, evidenciaBase, freteAplicavel: cotador.freteAplicavel, rebateAtual: atualRebate, cotador,
    snapshot: semSnapshot ? null : snapshot, snapshotCalculadoEm: semSnapshot ? null : iso(snapshot.calculatedAt),
  };
  const cenarios = [];
  for (const t of tarefas) {
    // preco_alvo itera (cada passo depende da cotação do anterior); os demais já têm a cotação em mãos.
    const r = t.tipo === "preco_alvo" ? await resolverPrecoAlvo(t, ctx) : calcularTarefa(t, ctx);
    delete r._rebateAtual;
    // A composição de hoje vai uma vez na raiz, não repetida em cada cenário.
    delete r.atual;
    cenarios.push(r);
  }

  const atualCalc = core.calcularAtual({ atual, frete_aplicavel: cotador.freteAplicavel });
  const estatisticas = cotador.estatisticas();
  // Topo da Bancada: preço cheio do ITEM (nunca o original_price de uma promoção) e a Base dos custos.
  const precoCheioItem = semSnapshot ? { valor: null, fonte: null } : resolverPrecoCheio(snapshot, null);
  const base = semSnapshot ? null : await baseDoSnapshot(snapshot, d);

  return {
    ok: true,
    cliente_conta_id: escopo.conta.id,
    mlb: pedido.mlb,
    gerado_em: geradoEm,
    item: {
      titulo: (snapshot && snapshot.titulo) || (anuncio && anuncio.titulo) || null,
      sku: (snapshot && snapshot.sku) || (anuncio && anuncio.sku) || null,
      ml_promos_url: urlPromocoesMl(pedido.mlb),
    },
    atual: {
      ...atualCalc.atual,
      // A alíquota que deu o `imposto` (o núcleo só calcula imposto com alíquota válida): "Imposto %" sem conta na tela.
      aliquota: atualCalc.atual.imposto === null ? null : num(atual.aliquota),
      preco_cheio: precoCheioItem.valor,
      preco_cheio_fonte: precoCheioItem.fonte,
      base,
      bloqueios: atualCalc.bloqueios,
      rebate_motivo: atualRebate.rebateMotivo || null,
      evidencia: semSnapshot
        ? { fonte: "margin_snapshot", motivo: snapshot && snapshot.catalogMissingSince ? "item_fora_do_catalogo" : core.MOTIVOS.SEM_SNAPSHOT_MARGEM }
        : {
            preco: { fonte: "margin_snapshot", calculado_em: iso(snapshot.calculatedAt) },
            comissao: { fonte: "margin_snapshot", calculado_em: iso(snapshot.calculatedAt) },
            frete: { fonte: "margin_snapshot", calculado_em: iso(snapshot.calculatedAt) },
            ...evidenciaBase,
            rebate: atualRebate.rebate !== null
              ? { fonte: "promo_snapshot", snapshot_em: iso(estadoPromo && estadoPromo.snapshotAt) }
              : { fonte: null, motivo: atualRebate.rebateMotivo || "sem_promocao_em_andamento" },
          },
    },
    meta,
    promocoes: precisaPromo
      ? {
          disponivel: promocoes.disponivel,
          motivo: promocoes.motivo,
          origem: promocoes.origem,
          snapshot_em: promocoes.origem === "diagnostico_legado"
            ? iso(promocoes.diagnostico.createdAt)
            : promocoes.estado ? iso(promocoes.estado.snapshotAt) : null,
          run_id: promocoes.estado ? promocoes.estado.snapshotRunId : null,
          parcial: promocoes.origem === "diagnostico_legado"
            ? promocoes.diagnostico.parcial === true
            : promocoes.estado ? promocoes.estado.partial === true : null,
        }
      : null,
    fontePromocoes,
    cotacoes: {
      consultas: estatisticas.chamadas,
      precos_distintos: estatisticas.precos_distintos,
      limite_excedido: estatisticas.limite_excedido,
      maximo_por_requisicao: MAX_COTACOES_POR_REQUISICAO,
    },
    cenarios,
  };
}

const MAX_ITENS_COMPOSICAO = 200;

/**
 * POST /api/margem/composicao — LC e margem de VÁRIOS jogos de insumos de uma
 * conta (a "Composição" da tabela com fontes personalizadas, a simulação
 * avançada e o impacto das divergências). Cálculo puro do núcleo: nada é
 * buscado no ML nem no banco além da autorização por carteira. Cada item pode
 * trazer `base_insumos` (Δ LC e Δ margem em pp contra ela) e `meta_margem`
 * (Δ em pp contra a meta, fração 0–1).
 */
async function calcularComposicoes({ user, body } = {}, deps = {}) {
  const d = defaults(deps);
  const b = body && typeof body === "object" ? body : {};
  const contaId = parseInteiroPositivo(b.cliente_conta_id ?? b.clienteContaId);
  if (contaId === null) throw erroHttp(400, "CLIENTE_CONTA_ID_OBRIGATORIO", "cliente_conta_id é obrigatório.");
  if (Number.isNaN(contaId)) throw erroHttp(400, "CLIENTE_CONTA_ID_INVALIDO", "cliente_conta_id inválido.");
  if (!Array.isArray(b.itens) || b.itens.length === 0) throw erroHttp(400, "ITENS_OBRIGATORIOS", "Informe ao menos um item em `itens`.");
  if (b.itens.length > MAX_ITENS_COMPOSICAO) {
    throw erroHttp(400, "ITENS_DEMAIS", `No máximo ${MAX_ITENS_COMPOSICAO} itens por requisição.`, { maximo: MAX_ITENS_COMPOSICAO });
  }
  const itens = b.itens.map((it, i) => {
    if (!it || typeof it !== "object") throw erroHttp(400, "ITEM_INVALIDO", `itens[${i}] precisa ser um objeto.`);
    const id = String(it.id ?? "").trim();
    if (!id || id.length > 80) throw erroHttp(400, "ITEM_ID_OBRIGATORIO", `itens[${i}].id é obrigatório.`);
    const saida = { id, insumos: validarInsumos(it.insumos, i) };
    if (it.base_insumos !== undefined && it.base_insumos !== null) saida.base = validarInsumos(it.base_insumos, i);
    if (it.meta_margem !== undefined && it.meta_margem !== null) {
      const meta = Number(it.meta_margem);
      if (!Number.isFinite(meta)) throw erroHttp(400, "META_MARGEM_INVALIDA", `itens[${i}].meta_margem precisa ser um número (fração).`);
      saida.meta_margem = meta;
    }
    return saida;
  });
  const { conta } = await autorizarConta(user, contaId, d);
  return {
    ok: true,
    cliente_conta_id: Number(conta.id),
    itens: itens.map((it) => ({ id: it.id, ...core.calcularComposicao(it.insumos, { base: it.base || null, meta_margem: it.meta_margem ?? null }) })),
  };
}

module.exports = {
  simular,
  calcularComposicoes,
  MAX_ITENS_COMPOSICAO,
  validarCorpo,
  montarTarefas,
  MAX_CENARIOS,
  MAX_PROMOS_POR_ITEM,
  MAX_COTACOES_POR_REQUISICAO,
  MAX_ITERACOES_PRECO_ALVO,
};
