// server/services/motorMargem/precificacao/precificacaoAvaliacao.js
// Central de Margem — avaliação AO VIVO de uma alteração de preço/promoção
// de UM anúncio: contexto da conta, números do Motor, recotação de comissão
// e frete no novo preço, e os GATES que decidem se a escrita é permitida.
//
// A UI não é autoridade: preview e aplicar chamam esta mesma avaliação, e o
// aplicar a refaz do zero antes de escrever. Nenhuma fórmula nova:
//   - números atuais ............ motorMargemService.montarItens (1 item)
//   - comissão/frete no novo preço marketplaceCurrentQuoteService.buscarComissaoEFrete
//                                  (a MESMA consulta que o Motor usa)
//   - lucro/margem .............. core/marginEngine.computeMargin
//   - promoções ................. meliPromocoesService.listarPromocoesDoItem
// Decisões financeiras sem regra oficial NÃO viram bloqueio (ver
// docs/AUDITORIA_CENTRAL_MARGEM_OPERACIONAL_PRECIFICACAO.md §5): a meta de
// margem é só aviso; variação % não tem limite.

// Núcleo puro (calcularCenario/DEFAULT_TARGET_MARGIN): carregado no topo — sem I/O.
const core = require("../core");
const margemConfiavel = require("../margemConfiavel");
const { resumoDoFrete } = require("../../shared/freteCotacaoConfiavel");
// Fonte única dos tipos de promoção em que o VenForce escreve (a mesma de /anuncios). Pura.
const tiposSuportados = require("../../meliAnuncios/promocaoTiposSuportados");

const TOLERANCIA_PRECO = 0.005; // meio centavo: preços comparados em 2 casas

// Status BRUTOS que podem virar PUT numa promoção ATIVA — mesma regra de
// meliPromocoesEscritaService (STATUS_ALTERAVEL, não exportado). A decisão
// final continua sendo do serviço de escrita, que relê ao vivo de novo.
const STATUS_PROMO_ALTERAVEL = new Set(["started", "active"]);

// Frete combinável não tem custo previsto pelo ML (mesma regra de
// buscarComissaoEFrete): ausência aqui é legítima, não defeito.
const LOGISTICA_SEM_FRETE_PREVISTO = new Set(["not_specified", "custom", ""]);

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

function round2(v) {
  return v === null ? null : Math.round((v + Number.EPSILON) * 100) / 100;
}

function valor(evidencia) {
  return evidencia && evidencia.value !== null && evidencia.value !== undefined ? num(evidencia.value) : null;
}

function mesmoPreco(a, b) {
  return a !== null && b !== null && Math.abs(a - b) < TOLERANCIA_PRECO;
}

/**
 * Preço digitado pelo operador: número, > 0 e no máximo 2 casas. Nunca
 * arredonda em silêncio — "114,999" é recusado, não vira 115,00.
 */
function validarPreco(bruto, { campo = "novoPreco", obrigatorio = true } = {}) {
  if (bruto === null || bruto === undefined || bruto === "") {
    return obrigatorio
      ? { ok: false, codigo: "PRECO_AUSENTE", motivo: "Informe o novo preço." }
      : { ok: true, valor: null };
  }
  const texto = String(bruto).trim().replace(",", ".");
  const n = Number(texto);
  if (!Number.isFinite(n) || n <= 0) {
    return { ok: false, codigo: "PRECO_INVALIDO", motivo: `O campo ${campo} precisa ser um número maior que zero.` };
  }
  if (!/^\d+(\.\d{1,2})?$/.test(texto)) {
    return { ok: false, codigo: "PRECO_CASAS_DECIMAIS", motivo: "O preço aceita no máximo duas casas decimais." };
  }
  return { ok: true, valor: round2(n) };
}

function erroDeRespostaMl(resp, contexto) {
  const status = resp && resp.status;
  if (status === 404) return erroHttp(404, "ITEM_NAO_ENCONTRADO_ML", "Anúncio não encontrado no Mercado Livre para esta conta.");
  if (status === 429) {
    return erroHttp(429, "ML_RATE_LIMIT", "O Mercado Livre pediu uma pausa (limite de requisições). Tente de novo em instantes.", {
      retryAfter: resp && resp.retryAfter != null ? resp.retryAfter : null,
    });
  }
  return erroHttp(502, "ML_INDISPONIVEL", `Não foi possível ler ${contexto} no Mercado Livre agora.`);
}

function defaults(deps = {}) {
  return {
    resolverContaDoCliente: deps.resolverContaDoCliente || require("../marginSnapshotApiService").resolverContaDoCliente,
    resolveAccountContext:
      deps.resolveAccountContext || require("../../clienteContas/clienteContaService").resolveMarketplaceAccountContext,
    mlFetch: deps.mlFetch || require("../../../utils/mlClient").mlFetch,
    montarItens: deps.montarItens || require("../motorMargemService").montarItens,
    buscarComissaoEFrete:
      deps.buscarComissaoEFrete || require("../../shared/marketplaceCurrentQuoteService").buscarComissaoEFrete,
    listarPromocoesDoItem:
      deps.listarPromocoesDoItem || require("../../meliAnuncios/meliPromocoesService").listarPromocoesDoItem,
    tiposComEscrita: deps.tiposComEscrita || require("../../meliAnuncios/meliPromocoesEscritaService").TIPOS_COM_ESCRITA,
    tiposAceite: deps.tiposAceite || tiposSuportados.TIPOS_ESCRITA_ACEITE,
    computeMargin: deps.computeMargin || require("../core/marginEngine").computeMargin,
  };
}

/**
 * Conta (pertence ao cliente, MELI, ativa, grant utilizável) + anúncio ao
 * vivo (dono, variações, metadados de cotação) + números do Motor.
 * Anúncio de outra conta volta com `contaCorreta:false` e SEM números do
 * Motor — nada é calculado para um item que não é desta conta.
 */
async function carregarContexto({ clienteSlug, clienteContaId, itemId }, deps = {}) {
  const d = defaults(deps);
  const id = String(itemId || "").trim().toUpperCase();
  if (!/^MLB\d+$/.test(id)) throw erroHttp(400, "ITEM_ID_INVALIDO", "Informe um anúncio (MLB) válido.");

  const { cliente, conta } = await d.resolverContaDoCliente({ clienteSlug, clienteContaId }, deps);

  let contexto;
  try {
    contexto = await d.resolveAccountContext({
      clienteId: cliente.id,
      marketplace: "meli",
      clienteContaId: conta.id,
      requireUsableGrant: true,
    });
  } catch (err) {
    throw erroHttp(409, "GRANT_ML_INDISPONIVEL", "A conexão desta conta com o Mercado Livre não está utilizável. Reconecte a conta em Clientes.", {
      causa: err && (err.code || null),
    });
  }
  const mlUserId = contexto && contexto.mlUserId ? String(contexto.mlUserId) : null;
  if (!mlUserId) {
    throw erroHttp(409, "CONTA_SEM_GRANT_ML", "Esta conta não tem uma conexão do Mercado Livre vinculada.");
  }

  const resp = await d.mlFetch(
    cliente.id,
    `/items/${encodeURIComponent(id)}?attributes=id,title,seller_id,status,variations,listing_type_id,category_id,shipping,seller_custom_field`,
    { mlUserId, ...(deps.mlTimeoutMs ? { timeoutMs: deps.mlTimeoutMs } : {}) }
  );
  if (!resp || !resp.ok || !resp.data) throw erroDeRespostaMl(resp, "o anúncio");
  const body = resp.data;
  const anuncio = {
    itemId: id,
    titulo: body.title || null,
    sku: body.seller_custom_field || null,
    sellerId: body.seller_id != null ? String(body.seller_id) : null,
    status: body.status || null,
    temVariacao: Array.isArray(body.variations) && body.variations.length > 0,
    listingTypeId: body.listing_type_id || null,
    categoryId: body.category_id || null,
    logisticType: (body.shipping && body.shipping.logistic_type) || "",
    // Tags do envio da MESMA leitura: a recotação não precisa reler o anúncio.
    shippingTags: body.shipping && Array.isArray(body.shipping.tags) ? body.shipping.tags : null,
  };
  const contaCorreta = anuncio.sellerId !== null && anuncio.sellerId === mlUserId;

  const base = {
    cliente: { id: Number(cliente.id), slug: cliente.slug, nome: cliente.nome || null },
    conta: { id: Number(conta.id), nome: conta.nome || null, mlUserId },
    anuncio,
    contaCorreta,
    motor: null,
  };
  if (!contaCorreta) return base;

  const resultado = await d.montarItens({ clienteSlug: cliente.slug, clienteContaId: conta.id, itemIds: [id] });
  const item = ((resultado && resultado.itens) || []).find((it) => it && it.identity && String(it.identity.itemId) === id);
  if (!item) throw erroHttp(404, "ITEM_NAO_ENCONTRADO_MOTOR", "O Motor de Margem não conseguiu ler este anúncio agora.");

  const target = (item.margin && item.margin.target) || {};
  const quality = item.quality || {};
  base.motor = {
    precoAtual: valor(item.pricing.current),
    precoLista: valor(item.pricing.list),
    precoPromocional: valor(item.pricing.promo),
    custo: valor(item.costs.cost.projected),
    imposto: valor(item.costs.taxRate.projected),
    taxaFixa: valor(item.costs.fixedFee.projected),
    comissao: valor(item.marketplaceCosts.commissionProjected),
    comissaoTaxa: valor(item.marketplaceCosts.commissionRate),
    frete: valor(item.marketplaceCosts.freightProjected),
    // Nível/fonte do frete do Motor (estimado × cotado), quando o seller tem a verificação ligada.
    freteQualidade: (item.diagnostico && item.diagnostico.freteQualidade) || null,
    metaMargem: num(target.marginTarget),
    breakEven: num(target.breakEvenPrice),
    precoAlvo: num(target.price),
    status: quality.status || null,
    confianca: quality.confidence || null,
    temConflito: quality.hasConflict === true,
    vendas: item.sales
      ? { unidades: num(item.sales.unidades), pedidos: num(item.sales.pedidos), receita: num(item.sales.receita) }
      : null,
  };
  if (!base.anuncio.titulo) base.anuncio.titulo = item.identity.titulo || null;
  if (!base.anuncio.sku) base.anuncio.sku = item.identity.sku || null;
  return base;
}

/**
 * Comissão e frete NO NOVO PREÇO. A comissão do ML tem faixas (custo fixo
 * abaixo de um valor) e o frete grátis muda ao cruzar o limiar — reusar os
 * números do preço atual subestimaria o impacto. Falha na recotação nunca
 * vira zero: cai para a taxa do Motor (comissão) ou o frete atual, MARCADO
 * pela fonte. Esses fallbacks só servem à SIMULAÇÃO: no modo escrita
 * (preview/aplicar) `avaliar` bloqueia qualquer fonte que não seja uma
 * cotação real (RECOTACAO_INDISPONIVEL).
 */
async function recotar(base, preco, deps = {}) {
  const d = defaults(deps);
  const m = base.motor;
  if (mesmoPreco(preco, m.precoAtual)) {
    return { comissao: m.comissao, comissaoFonte: "motor", frete: m.frete, freteFonte: "motor", freteQualidade: m.freteQualidade || null };
  }
  let cotacao = { comissaoValor: null, fretePrevisto: null };
  // Prazo real também nas cotações (listing_prices / shipping_options).
  const fetchComPrazo = deps.mlTimeoutMs && !deps.buscarComissaoEFrete
    ? (clienteId, caminho, opts = {}) => require("../../../utils/mlClient").mlFetch(clienteId, caminho, { ...opts, timeoutMs: deps.mlTimeoutMs })
    : undefined;
  try {
    cotacao = await d.buscarComissaoEFrete({
      clienteId: base.cliente.id,
      itemId: base.anuncio.itemId,
      precoEfetivo: preco,
      listingTypeId: base.anuncio.listingTypeId,
      categoryId: base.anuncio.categoryId,
      sellerId: base.anuncio.sellerId,
      logisticType: base.anuncio.logisticType,
      mlUserId: base.conta.mlUserId,
      shippingTags: base.anuncio.shippingTags || null,
    }, ...(fetchComPrazo ? [fetchComPrazo] : []));
  } catch (_) {
    cotacao = { comissaoValor: null, fretePrevisto: null };
  }

  let comissao = num(cotacao.comissaoValor);
  let comissaoFonte = "recotada";
  if (comissao === null) {
    if (m.comissaoTaxa !== null) {
      comissao = round2(preco * m.comissaoTaxa);
      comissaoFonte = "taxa";
    } else {
      comissaoFonte = "indisponivel";
    }
  }

  let frete = num(cotacao.fretePrevisto);
  let freteFonte = "recotado";
  if (frete === null) {
    if (LOGISTICA_SEM_FRETE_PREVISTO.has(base.anuncio.logisticType || "")) {
      freteFonte = "nao_aplicavel";
    } else if (m.frete !== null) {
      frete = m.frete;
      freteFonte = "atual";
    } else {
      freteFonte = "indisponivel";
    }
  }
  // Só acompanha o valor quando ele veio DESTA cotação (nunca do fallback).
  return { comissao, comissaoFonte, frete, freteFonte, freteQualidade: freteFonte === "recotado" ? (cotacao.freteQualidade || null) : null };
}

/**
 * Situação de escrita de uma promoção normalizada (espelha os serviços de escrita).
 * Dois modos:
 *   preco   DEAL/SELLER_CAMPAIGN — o vendedor escolhe o preço: PARTICIPAR (candidate) ou ALTERAR (a ATIVA);
 *   aceite  SMART, PRICE_MATCHING… — o ML define o preço: só PARTICIPAR (candidate), no preço sugerido.
 * Tipos fora dos dois conjuntos (PRICE_DISCOUNT, DOD, LIGHTNING, VOLUME…) ficam só em simulação, com o motivo.
 */
function escritaDaPromocao(promo, tiposComEscrita, tiposAceite = tiposSuportados.TIPOS_ESCRITA_ACEITE) {
  if (!promo) return { suportada: false, acao: null, modo: null, motivo: "Promoção não encontrada." };
  const preco = tiposComEscrita.has(promo.tipo);
  const aceite = !preco && Boolean(tiposAceite) && tiposAceite.has(promo.tipo);
  if (!preco && !aceite) {
    return {
      suportada: false,
      acao: null,
      modo: null,
      motivo: `Somente simulação: ${tiposSuportados.motivoTipoSemEscrita(promo.tipo)} — participe pelo painel do Mercado Livre.`,
    };
  }
  const modo = preco ? "preco" : "aceite";
  if (STATUS_PROMO_ALTERAVEL.has(promo.status) && promo.statusExibicao === "ATIVA") {
    return preco
      ? { suportada: true, acao: "ALTERAR", modo, motivo: null }
      : { suportada: false, acao: null, modo, motivo: "O Mercado Livre define o preço desta promoção — não há preço a alterar por aqui." };
  }
  if (promo.status === "candidate") return { suportada: true, acao: "PARTICIPAR", modo, motivo: null };
  if (promo.status === "pending") {
    return { suportada: false, acao: null, modo, motivo: "Promoção programada: ainda não começou no Mercado Livre — só simulação." };
  }
  return {
    suportada: false,
    acao: null,
    modo,
    motivo: "Esta promoção existe, mas não é a que define o preço atual do anúncio — só simulação.",
  };
}

function gate(id, grupo, tom, titulo, detalhe = null) {
  return { id, grupo, tom, titulo, detalhe };
}

// Veredito do núcleo (calcularCenario — a mesma conta do simulador) como GATE da participação:
// `nao_entrar` e `bloqueado` impedem a escrita; `entrar_se_girar` avisa (LC por unidade cai ou margem
// abaixo da meta — o operador decide vendo o volume de empate); `entrar` passa.
function gateVeredito(cenario) {
  const v = cenario.veredito;
  if (v === "entrar") return gate("veredito", "PROMOCAO", "ok", "Veredito: entrar", "O LC por unidade não cai e a margem fica na meta.");
  if (v === "entrar_se_girar") {
    const empate = cenario.empate_volume !== null && cenario.empate_volume !== undefined && cenario.empate_volume > 0
      ? ` Precisa vender ${pct(cenario.empate_volume)} a mais para empatar o LC total de hoje.` : "";
    return gate("veredito", "PROMOCAO", "warn", "Veredito: entrar se girar", `${cenario.motivo === "lc_por_unidade_cai" ? "O LC por unidade cai." : "A margem fica abaixo da meta."}${empate}`);
  }
  if (v === "nao_entrar") {
    return gate("veredito", "PROMOCAO", "block", "Veredito: não entrar",
      cenario.motivo === "lc_nao_positivo" ? "O LC por unidade fica zero ou negativo nesta promoção." : "A margem fica abaixo do mínimo nesta promoção.");
  }
  return gate("veredito", "PROMOCAO", "block", "Veredito bloqueado", `Sem número confiável para decidir: ${(cenario.motivos || [cenario.motivo]).filter(Boolean).join(", ") || "motivo não informado"}.`);
}

function pct(fracao) {
  return fracao === null || fracao === undefined ? "—" : `${(fracao * 100).toFixed(1).replace(".", ",")}%`;
}

function brl(v) {
  return v === null || v === undefined ? "—" : `R$ ${Number(v).toFixed(2).replace(".", ",")}`;
}

/**
 * Cálculo antes × depois + gates. PURA sobre o contexto já carregado.
 * @param {object} p
 *  - base        carregarContexto()
 *  - tipo        "PRICE" | "PROMOTION"
 *  - novoPreco   preço proposto (já validado) — para promoção, o deal_price
 *  - precoVisto  preço que a tela mostrou ao operador (stale check)
 *  - recote      recotar(base, novoPreco)
 *  - promocao    promoção normalizada (releitura ao vivo) ou null
 *  - promocaoEncontrada  false quando a promoção pedida sumiu da releitura
 */
function avaliar({ base, tipo, novoPreco, precoVisto, recote, promocao = null, promocaoEncontrada = true, modo = "simulacao" }, deps = {}) {
  const escritaReal = modo === "escrita";
  const d = defaults(deps);
  const gates = [];

  // ── CONTA ────────────────────────────────────────────────────────────────
  gates.push(gate("conta", "CONTA", "ok", "Conta correta", `${base.conta.nome || "Conta"} · Mercado Livre ${base.conta.mlUserId}`));
  gates.push(
    base.contaCorreta
      ? gate("anuncio_conta", "CONTA", "ok", "Anúncio pertence à conta")
      : gate("anuncio_conta", "CONTA", "block", "Anúncio de outra conta", "Este MLB não pertence à conta selecionada. Troque a operação no topo.")
  );
  if (!base.contaCorreta || !base.motor) {
    return { gates, bloqueado: true, atual: null, proposta: null, promocao: null };
  }

  const m = base.motor;
  const insumos = { cost: m.custo, taxRate: m.imposto, fixedFee: m.taxaFixa };
  // P0 04/11/2026: comissão/frete do ML ausentes ⇒ sem margem (o núcleo
  // assumiria 0: preço 50 → 46%). Frete combinável não é ausência.
  const freteAplicavelAnuncio = margemConfiavel.freteAplicavelDaLogistica(base.anuncio ? base.anuncio.logisticType : undefined);
  const semMargem = (calc, faltando) => ({ ...calc, computable: false, margin: null, profit: null,
    missing: Array.from(new Set([...(calc.missing || []), ...faltando])) });
  const faltandoMarketplace = (comissao, frete, freteAplicavel) => [
    comissao === null || comissao === undefined ? "commission" : null,
    (frete === null || frete === undefined) && freteAplicavel !== false ? "freight" : null,
  ].filter(Boolean);
  const antesBruto = d.computeMargin({ price: m.precoAtual, ...insumos, commission: m.comissao, freight: m.frete });
  const faltandoAntes = faltandoMarketplace(m.comissao, m.frete, freteAplicavelAnuncio);
  const antes = faltandoAntes.length ? semMargem(antesBruto, faltandoAntes) : antesBruto;
  const rebate = tipo === "PROMOTION" && promocao && promocao.subsidioMl !== null && promocao.subsidioMl !== undefined
    ? Number(promocao.subsidioMl)
    : 0;
  const depoisBruto = novoPreco === null
    ? { computable: false, profit: null, margin: null, missing: ["price"], assumed: [] }
    : d.computeMargin({ price: novoPreco, ...insumos, commission: recote.comissao, freight: recote.frete, rebate });
  const faltandoDepois = novoPreco === null ? [] : faltandoMarketplace(
    recote.comissao, recote.frete, recote.freteFonte === "nao_aplicavel" ? false : freteAplicavelAnuncio
  );
  const depois = faltandoDepois.length ? semMargem(depoisBruto, faltandoDepois) : depoisBruto;

  // ── DADOS ────────────────────────────────────────────────────────────────
  gates.push(
    m.custo !== null
      ? gate("custo", "DADOS", "ok", "Custo da Base encontrado", brl(m.custo))
      : gate("custo", "DADOS", "block", "Custo ausente na Base", "Sem custo não existe margem defensável. Complete a Base antes de precificar.")
  );
  gates.push(
    m.imposto !== null
      ? gate("imposto", "DADOS", "ok", "Imposto declarado", pct(m.imposto))
      : gate("imposto", "DADOS", "block", "Imposto não declarado na Base", "O Motor assumiria 0% e superestimaria a margem. Declare o imposto (0% é aceito).")
  );
  gates.push(
    antes.computable
      ? gate("motor", "DADOS", "ok", "Motor computável")
      : gate("motor", "DADOS", "block", "Motor não calcula a margem atual", `Falta: ${(antes.missing || []).join(", ")}.`)
  );
  // Cotação REAL: recotada no novo preço, ou a do Motor quando o preço não
  // muda (é a mesma consulta, feita pelo Motor no preço atual) — com valor.
  const comissaoConfirmada = recote.comissao !== null && recote.comissao !== undefined &&
    (recote.comissaoFonte === "recotada" || recote.comissaoFonte === "motor");
  const freteConfirmado = recote.freteFonte === "nao_aplicavel" ||
    (recote.frete !== null && recote.frete !== undefined && (recote.freteFonte === "recotado" || recote.freteFonte === "motor"));
  const resumoFrete = resumoDoFrete({ fretePrevisto: recote.frete, freteQualidade: recote.freteQualidade || null });
  const freteEstimado = freteConfirmado && resumoFrete.estimado;
  // Estimativa de confiança BAIXA (mediana de custos cobrados) ou apoiada em envios antigos: serve para
  // simular, não para gravar preço/promoção no Mercado Livre sem o operador revisar a embalagem.
  const freteFracoParaEscrita = freteEstimado && (resumoFrete.confianca === "baixa" || Boolean(recote.freteQualidade && recote.freteQualidade.historicoAntigo));
  // Flex: o custo do entregador próprio não está em NENHUMA margem calculada aqui.
  const foraDaMargem = freteConfirmado && resumoFrete.custosForaDaMargem.length > 0;
  if (comissaoConfirmada) {
    gates.push(gate("comissao", "DADOS", "ok", "Comissão do Mercado Livre no novo preço", brl(recote.comissao)));
  } else if (escritaReal) {
    gates.push(gate("comissao", "DADOS", "block", "Comissão não recotada — escrita bloqueada",
      "O Mercado Livre não confirmou a tarifa neste preço. Estimativa não é aceita para escrita real; tente de novo em instantes."));
  } else if (recote.comissaoFonte === "taxa") {
    gates.push(gate("comissao", "DADOS", "warn", "Comissão estimada pela taxa", "O Mercado Livre não recotou a tarifa neste preço; usada a taxa atual do anúncio (só simulação)."));
  } else {
    gates.push(gate("comissao", "DADOS", "block", "Comissão indisponível", "Sem a tarifa do Mercado Livre a margem nova não é confiável."));
  }
  if (freteConfirmado) {
    gates.push(recote.freteFonte === "nao_aplicavel"
      ? gate("frete", "DADOS", "ok", "Frete combinável", "Sem custo de frete previsto pelo Mercado Livre.")
      : freteFracoParaEscrita && escritaReal
        ? gate("frete", "DADOS", "block", "Frete estimado com pouca confiança — escrita bloqueada",
          `${brl(recote.frete)} — ${resumoFrete.texto} Declare as medidas da embalagem no anúncio ou revise o frete antes de gravar.`)
      : freteEstimado
        // Estimativa validada contra cobranças reais, mas não é cotação do anúncio nem cobrança: avisa, não bloqueia.
        ? gate("frete", "DADOS", "warn", "Frete estimado no novo preço", `${brl(recote.frete)} — ${resumoFrete.texto}`)
        : foraDaMargem
          ? gate("frete", "DADOS", "warn", "Frete previsto; entregador Flex fora da margem", `${brl(recote.frete)} — ${resumoFrete.texto}`)
          : gate("frete", "DADOS", "ok", "Frete previsto no novo preço", brl(recote.frete)));
  } else if (escritaReal) {
    gates.push(gate("frete", "DADOS", "block", "Frete não recotado — escrita bloqueada",
      "O Mercado Livre não confirmou o frete para o novo preço. Frete do preço anterior ou zero não são aceitos para escrita real."));
  } else if (recote.freteFonte === "atual") {
    gates.push(gate("frete", "DADOS", "warn", "Frete não recotado", "Usado o frete do preço atual — cruzar o limiar de frete grátis pode mudar o custo (só simulação)."));
  } else {
    gates.push(gate("frete", "DADOS", "warn", "Frete indisponível", "Entrou como zero declarado no cálculo (só simulação)."));
  }

  // ── PREÇO ────────────────────────────────────────────────────────────────
  if (precoVisto === null || precoVisto === undefined) {
    gates.push(gate("preco_confirmado", "PRECO", "warn", "Preço visto não informado", "Não foi possível comparar com o preço atual do Mercado Livre."));
  } else if (mesmoPreco(Number(precoVisto), m.precoAtual)) {
    gates.push(gate("preco_confirmado", "PRECO", "ok", "Preço atual confirmado", brl(m.precoAtual)));
  } else {
    gates.push(
      gate("preco_confirmado", "PRECO", "block", "Preço alterado desde o preview. Atualize e tente novamente.",
        `A tela mostrou ${brl(precoVisto)}; o Mercado Livre informa ${brl(m.precoAtual)} agora.`)
    );
  }
  if (depois.computable) {
    gates.push(
      depois.profit >= 0
        ? gate("break_even", "PRECO", "ok", "Acima do break-even", m.breakEven !== null ? `Break-even de referência ${brl(m.breakEven)}` : null)
        : gate("break_even", "PRECO", "block", "Abaixo do break-even", `LC ficaria em ${brl(depois.profit)} por unidade.`)
    );
  }
  if (tipo === "PRICE") {
    if (novoPreco !== null && mesmoPreco(novoPreco, m.precoAtual)) {
      gates.push(gate("sem_mudanca", "PRECO", "block", "Novo preço igual ao atual"));
    }
    if (base.anuncio.temVariacao) {
      gates.push(gate("variacao", "PRECO", "block", "Anúncio com variações", "A edição de preço por variação ainda não está disponível."));
    }
    if (m.precoPromocional !== null) {
      gates.push(
        gate("promocao_ativa", "PRECO", "block", "Promoção ativa no anúncio",
          "O preço exibido é o promocional. Altere pela promoção (seção Promoções) em vez do preço base.")
      );
    }
  }

  // ── MARGEM ───────────────────────────────────────────────────────────────
  if (depois.computable && m.metaMargem !== null) {
    gates.push(
      depois.margin >= m.metaMargem
        ? gate("meta", "MARGEM", "ok", "Margem na meta de referência", `Meta ${pct(m.metaMargem)} (referência do Motor)`)
        : gate("meta", "MARGEM", "warn", "Margem abaixo da meta", `Meta de referência ${pct(m.metaMargem)} — não existe margem mínima oficial; não bloqueia.`)
    );
  }

  // ── INTEGRIDADE ──────────────────────────────────────────────────────────
  if (m.status === "UNVALIDATED") {
    gates.push(gate("integridade", "INTEGRIDADE", "block", "Dado obrigatório não validado pelo Motor"));
  } else if (m.status === "SUSPECT_DATA" || m.temConflito || m.confianca === "LOW") {
    gates.push(gate("integridade", "INTEGRIDADE", "warn", "Integridade com ressalvas", "Há fontes em conflito ou confiança baixa. Confira Evidências antes de confirmar."));
  } else {
    gates.push(gate("integridade", "INTEGRIDADE", "ok", "Integridade adequada"));
  }

  // ── PROMOÇÃO ─────────────────────────────────────────────────────────────
  let promoOut = null;
  if (tipo === "PROMOTION") {
    if (!promocaoEncontrada || !promocao) {
      gates.push(gate("promocao_disponivel", "PROMOCAO", "block", "Promoção não está mais disponível", "Ela sumiu da releitura ao vivo do Mercado Livre. Atualize as promoções."));
    } else {
      gates.push(gate("promocao_disponivel", "PROMOCAO", "ok", "Promoção ainda disponível", `${promocao.nome || promocao.tipoLabel || promocao.tipo} · ${promocao.statusExibicao}`));
      const escrita = escritaDaPromocao(promocao, d.tiposComEscrita, d.tiposAceite);
      const aceite = escrita.modo === "aceite";
      gates.push(
        escrita.suportada
          ? gate("promocao_escrita", "PROMOCAO", "ok",
            escrita.acao === "ALTERAR" ? "Alteração suportada" : aceite ? "Participação suportada (preço definido pelo Mercado Livre)" : "Participação suportada",
            promocao.tipoLabel || promocao.tipo)
          : gate("promocao_escrita", "PROMOCAO", "block", "Somente simulação", escrita.motivo)
      );
      // ACEITE: o vendedor só aceita — o preço é o SUGERIDO pelo ML, nunca um digitado.
      const precoSugerido = aceite ? num(promocao.precoFinal) : null;
      if (aceite && escrita.acao === "PARTICIPAR" && tiposSuportados.aceiteExigeOffer(promocao.tipo) && !promocao.refId) {
        gates.push(gate("promocao_oferta", "PROMOCAO", "block", "Oferta do Mercado Livre não informada",
          "O Mercado Livre não devolveu o identificador da oferta desta promoção — participe pelo painel do Mercado Livre."));
      }
      if (aceite && precoSugerido === null) {
        gates.push(gate("promocao_preco", "PROMOCAO", "block", "Sem preço sugerido pelo Mercado Livre",
          "Nesta promoção o preço é definido pelo Mercado Livre e ele não informou o preço sugerido — não dá para calcular a margem."));
      } else if (aceite && novoPreco !== null && !mesmoPreco(novoPreco, round2(precoSugerido))) {
        gates.push(gate("promocao_preco", "PROMOCAO", "block", "Preço definido pelo Mercado Livre (não editável)",
          `Nesta promoção o preço é o sugerido pelo Mercado Livre: ${brl(precoSugerido)}.`));
      } else if (novoPreco === null) {
        gates.push(gate("promocao_preco", "PROMOCAO", "block", "Promoção sem preço sugerido", "Informe o preço promocional para simular."));
      } else if (promocao.precoOriginal !== null && promocao.precoOriginal !== undefined && novoPreco >= Number(promocao.precoOriginal)) {
        gates.push(gate("promocao_preco", "PROMOCAO", "block", "Preço promocional precisa ser menor que o original", `Original ${brl(promocao.precoOriginal)}.`));
      } else if (escrita.acao === "ALTERAR" && mesmoPreco(novoPreco, m.precoAtual)) {
        // Alterar a oferta ativa para o MESMO preço seria um PUT inócuo.
        gates.push(gate("promocao_preco", "PROMOCAO", "block", "Novo preço da oferta igual ao atual", "Informe um preço diferente para alterar a oferta."));
      } else if (aceite) {
        gates.push(gate("promocao_preco", "PROMOCAO", "ok", "Preço sugerido pelo Mercado Livre", `${brl(precoSugerido)} — o Mercado Livre confirma o preço final ao participar.`));
      } else {
        gates.push(gate("promocao_preco", "PROMOCAO", "ok", "Preço promocional válido", "O Mercado Livre ainda valida a faixa permitida ao confirmar."));
      }
      // Quem banca é medido contra o preço CHEIO (original da promoção, ou o de lista do
      // item) — nunca contra o preço atual, que já pode ser promocional. Sem nenhum dos
      // dois: banca null + `sem_preco_cheio` (não cai no preço atual).
      // Participar só com veredito do núcleo ≠ não entrar/bloqueado (alterar uma oferta já ativa segue só
      // pelos gates acima: o núcleo marca a promoção ativa como `bloqueado`, que não é o caso aqui).
      let veredito = null;
      if (escrita.acao === "PARTICIPAR" && novoPreco !== null) {
        veredito = core.calcularCenario({
          atual: { preco: m.precoAtual, custo: m.custo, aliquota: m.imposto, taxa_fixa: m.taxaFixa, comissao: m.comissao, frete: m.frete, rebate: 0 },
          cenario: { tipo: "promo", preco: novoPreco, rebate, status_promocao: promocao.status, status_exibicao: promocao.statusExibicao },
          cotacao: { comissao: recote.comissao, frete: recote.frete, frete_aplicavel: recote.freteFonte !== "nao_aplicavel" },
          meta: { margem_alvo: m.metaMargem !== null && m.metaMargem !== undefined ? m.metaMargem : core.DEFAULT_TARGET_MARGIN, margem_minima: 0 },
        });
        gates.push(gateVeredito(veredito));
      }
      const precoOriginal = num(promocao.precoOriginal) ?? m.precoLista ?? null;
      const desconto = novoPreco !== null && precoOriginal !== null ? round2(precoOriginal - novoPreco) : null;
      const mlBanca = rebate || null;
      const sellerBanca = desconto !== null ? round2(desconto - (mlBanca || 0)) : null;
      let bancaAviso = null;
      if (desconto !== null && desconto < 0) bancaAviso = "preco_acima_do_cheio";
      else if (sellerBanca !== null && sellerBanca < 0) bancaAviso = "retorno_maior_que_desconto";
      promoOut = {
        id: String(promocao.id),
        tipo: promocao.tipo,
        tipoLabel: promocao.tipoLabel || null,
        nome: promocao.nome || null,
        status: promocao.status,
        statusExibicao: promocao.statusExibicao,
        inicio: promocao.inicio || null,
        fim: promocao.fim || null,
        precoOriginal,
        descontoReais: desconto,
        descontoPercentual: desconto !== null && precoOriginal ? round2((desconto / precoOriginal) * 100) : null,
        mlBanca,
        sellerBanca,
        deltaPrecoAtual: novoPreco !== null && m.precoAtual !== null ? round2(m.precoAtual - novoPreco) : null,
        bancaMotivo: precoOriginal === null ? "sem_preco_cheio" : null,
        bancaAviso,
        meliPercentage: num(promocao.meliPercentage),
        sellerPercentage: num(promocao.sellerPercentage),
        refId: promocao.refId || null,
        precoSugerido: aceite ? precoSugerido : null,
        escrita,
        // Veredito do núcleo (o mesmo do /simular) com LC antes/depois — só quando há participação a decidir.
        veredito: veredito
          ? {
            veredito: veredito.veredito,
            motivo: veredito.motivo || null,
            motivos: veredito.motivos || [],
            lcAntes: veredito.atual ? veredito.atual.lc : null,
            lcDepois: veredito.cenario ? veredito.cenario.lc : null,
            deltaLc: veredito.delta_lc ?? null,
            margemAntes: veredito.atual ? veredito.atual.margem_ratio : null,
            margemDepois: veredito.cenario ? veredito.cenario.margem_ratio : null,
            empateVolume: veredito.empate_volume ?? null,
          }
          : null,
      };
    }
  }

  const variacaoReais = novoPreco !== null && m.precoAtual !== null ? round2(novoPreco - m.precoAtual) : null;
  const variacaoPercentual = variacaoReais !== null && m.precoAtual ? round2((variacaoReais / m.precoAtual) * 100) : null;

  return {
    modo: escritaReal ? "escrita" : "simulacao",
    gates,
    bloqueado: gates.some((g) => g.tom === "block"),
    atual: {
      preco: m.precoAtual,
      precoLista: m.precoLista,
      precoPromocional: m.precoPromocional,
      comissao: m.comissao,
      frete: m.frete,
      margem: antes.computable ? antes.margin : null,
      lucro: antes.computable ? antes.profit : null,
      metaMargem: m.metaMargem,
      breakEven: m.breakEven,
      precoAlvo: m.precoAlvo,
    },
    proposta: {
      preco: novoPreco,
      comissao: recote.comissao,
      comissaoFonte: recote.comissaoFonte,
      frete: recote.frete,
      freteFonte: recote.freteFonte,
      // null = seller sem a verificação de frete ligada (cotação do ML sem avaliação).
      freteDetalhe: recote.freteQualidade ? resumoFrete : null,
      rebate: rebate || 0,
      margem: depois.computable ? depois.margin : null,
      lucro: depois.computable ? depois.profit : null,
      assumido: depois.assumed || [],
      variacaoReais,
      variacaoPercentual,
    },
    insumos: { custo: m.custo, imposto: m.imposto, taxaFixa: m.taxaFixa, comissaoTaxa: m.comissaoTaxa },
    vendas: m.vendas,
    promocao: promoOut,
  };
}

// Gate bloqueante → código de recusa do aplicar.
function codigoDoGate(g) {
  if (!g) return "GATE_BLOQUEADO";
  if (g.id === "preco_confirmado") return "PRECO_ALTERADO";
  if (g.id === "comissao" || g.id === "frete") return "RECOTACAO_INDISPONIVEL";
  return `GATE_${String(g.id).toUpperCase()}`;
}

module.exports = {
  TOLERANCIA_PRECO,
  codigoDoGate,
  erroHttp,
  validarPreco,
  carregarContexto,
  recotar,
  avaliar,
  escritaDaPromocao,
  mesmoPreco,
};
