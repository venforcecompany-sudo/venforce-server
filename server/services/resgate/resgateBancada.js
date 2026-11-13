// server/services/resgate/resgateBancada.js
//
// BANCADA do anúncio: o que o operador precisa ver e decidir, montado no
// SERVIDOR a partir do item auditado (contrato resgate-contrato/1) + evidência
// de financiamento da promoção (resgatePromocaoFinanciamento) + recotação do
// preço sugerido, quando houver. A tela só exibe: nenhuma fórmula no front.
//
// Regras financeiras (inegociáveis):
//   · preço do COMPRADOR ≠ receita do VENDEDOR: receita = comprador + subsídio
//     comprovado do ML (o subsídio entra UMA vez, como `rebate` do núcleo);
//   · promoção 100% do vendedor tem subsídio 0 comprovado (não exige rebate > 0);
//   · sem evidência suficiente: pendência, nunca margem inventada;
//   · preço sugerido só é "liberado" quando RECOTADO no próprio preço (comissão e
//     frete cotados nele); o resto é simulação preliminar;
//   · margem e lucro vêm do núcleo do Motor (core.computeMargin), sem fórmula própria.
//
// Ações: a bancada só DESCREVE as opções e qual endpoint existente de
// /anuncios-meli as executaria. Não executa nada.

const { TIPOS_DO_VENDEDOR } = require("./resgatePromocaoFinanciamento");
const core = require("../motorMargem/core");
const { modoEscritaPromocao, motivoTipoSemEscrita } = require("../meliAnuncios/promocaoTiposSuportados");
const { FINANCIAMENTO } = require("./resgatePromocaoFinanciamento");

const VERSAO = "resgate-bancada/1";
const EPS = 1e-6;
const STATUS = { OK: "OK", ABAIXO_DA_META: "ABAIXO_DA_META", PREJUIZO: "PREJUIZO", MARGEM_DESCONHECIDA: "MARGEM_DESCONHECIDA", BLOQUEADO: "BLOQUEADO" };
const FILTROS = ["abaixo_meta", "prejuizo", "desconhecida", "promocao", "atencao", "na_meta"];

const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const r2 = (v) => (v === null ? null : Math.round((v + Number.EPSILON) * 100) / 100);
const ceil2 = (v) => Math.ceil((v - 1e-9) * 100) / 100;
// Textos para o operador em formato brasileiro (o valor numérico segue nos campos próprios).
const brl = (v) => "R$ " + Number(v).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pctBr = (fracao) => (Math.round(fracao * 10000) / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + "%";

/** Meta da requisição (fração 0–0,9): ?meta=0.15 ou 15 ou "15,5". Inválida = null (usa a meta do item). */
function metaDe(v) {
  if (v === undefined || v === null || v === "") return null;
  let n = Number(String(v).replace(",", "."));
  if (!Number.isFinite(n)) return null;
  if (n >= 1) n /= 100;
  return n >= 0 && n < 0.9 ? n : null;
}

/** Recotação no formato do arquivo da CLI (recotar_amostra) ou já normalizada. */
function normalizarRecotacao(q) {
  if (!q) return null;
  const r = q.recomendacao || q;
  const mudou = q.precoMudouDesdeAuditoria
    || (q.anuncioLido && num(q.anuncioLido.price) !== null && num(q.precoCheio) !== null && Math.abs(q.anuncioLido.price - q.precoCheio) > 0.009
      ? { cheioAuditoria: num(q.precoCheio), cheioAtual: num(q.anuncioLido.price) } : null);
  return {
    ok: Boolean(q.ok), motivo: q.motivo || null, meta: num(q.meta), recotadoEm: q.recotadoEm || null,
    preco: num(r.preco), comissao: num(r.comissao), comissaoPct: num(r.comissaoPct), frete: num(r.frete), freteNivel: r.freteNivel || null, freteConfianca: r.freteConfianca || null,
    margem: num(r.margem), lucro: num(r.lucro), margemConfiavel: Boolean(r.margemConfiavel),
    cenarioSairPromo: q.cenarioSairPromo || null, precoMudouDesdeAuditoria: mudou || null,
  };
}

function linha(chave, rotulo, operacao, valor, extra = {}) {
  return { chave, rotulo, operacao, valor: num(valor) === null ? null : r2(num(valor)), status: num(valor) === null ? (extra.status || "desconhecido") : (extra.status || "ok"), fonte: extra.fonte || null, confianca: extra.confianca || null, nota: extra.nota || null };
}

/**
 * @param {object} item  resultado da auditoria (resgate-auditoria/1)
 * @param {object} [o]
 * @param {object} [o.promocao]   saída de classificarFinanciamento (evidência lida). Padrão: item.promocaoFinanciamento
 *                                (gravado pelo enriquecimento da CLI); sem nenhum dos dois = subsídio do contrato
 * @param {object} [o.recotacao]  recotação do sugerido (formato da CLI ou normalizado). Padrão: item.recotacao
 * @param {number} [o.meta]       margem-alvo (fração). Padrão: meta do item
 * @param {string} [o.metaOrigem]
 */
function montarBancada(item, { promocao: promocaoIn = null, recotacao: recotacaoIn = null, meta = null, metaOrigem = null } = {}) {
  const promocao = promocaoIn || (item && item.promocaoFinanciamento) || null;
  const recotacao = recotacaoIn || (item && item.recotacao) || null;
  const c = (item && item.contrato) || {};
  const k = c.componentes || {};
  const v = (x) => (x ? num(x.valor) : null);
  const cheio = v(k.precoCheio), comprador = v(k.precoVigente);
  const promoAtiva = cheio !== null && comprador !== null && cheio > comprador + 0.001;
  const metaValor = num(meta) !== null ? num(meta) : (item && item.meta ? num(item.meta.valor) : null);
  const metaInfo = { valor: metaValor, origem: num(meta) !== null ? (metaOrigem || "definida na bancada") : (item && item.meta ? item.meta.origem : null), validada: num(meta) !== null ? true : Boolean(item && item.meta && item.meta.validada) };

  // ── Financiamento da promoção / subsídio ────────────────────────────────
  let promo;
  if (!promoAtiva) promo = { ativa: false, financiamento: null, subsidio: 0, comprovado: true, texto: "Sem promoção: o comprador paga o preço cheio.", fonte: null, tipo: null, id: null, nome: null, pendencia: null };
  else if (promocao) promo = { ativa: true, ...promocao };
  else {
    const s = k.subsidioMl || {};
    const conhecido = s.status === "ok" && num(s.valor) !== null;
    promo = {
      ativa: true, tipo: c.promocao && c.promocao.tipo || null, id: c.promocao && c.promocao.id || null, nome: c.promocao && c.promocao.nome || null, fonte: s.fonte || null,
      comprovado: conhecido, subsidio: conhecido ? num(s.valor) : null,
      financiamento: conhecido ? (num(s.valor) > 0 ? FINANCIAMENTO.COFINANCIADA : FINANCIAMENTO.VENDEDOR) : FINANCIAMENTO.INDETERMINADO,
      pendencia: conhecido ? null : "SUBSIDIO_NAO_VERIFICADO",
      texto: conhecido ? "Subsídio do ML registrado na auditoria." : "Promoção ativa sem leitura do financiamento: ler as promoções do anúncio (GET) para saber quem paga o desconto.",
    };
  }
  const subsidio = promo.comprovado ? num(promo.subsidio) : null;

  // ── Bloqueios e pendências (motivo exato) ────────────────────────────────
  const res = c.resultado || {};
  const bloqueios = (c.bloqueios || []).map((b) => ({ codigo: b.codigo, texto: b.texto, resolveCom: b.resolveCom || null }));
  if (!(item && item.sku) && bloqueios.some((b) => /CUSTO|IMPOSTO|TAXA/.test(b.codigo))) bloqueios.push({ codigo: "SEM_SKU", texto: "Anúncio sem SKU: sem vínculo com a Base de custos.", resolveCom: "Cadastrar o SKU no anúncio ou vincular o custo na Base." });
  const pendencias = [];
  if (k.frete && k.frete.status === "nao_verificado") pendencias.push({ codigo: "FRETE_NAO_VERIFICADO", texto: "Frete gravado sem verificação de confiabilidade (conta fora da liberação): recalcular a conta." });
  if (promoAtiva && !promo.comprovado) pendencias.push({ codigo: promo.pendencia || "SUBSIDIO_NAO_VERIFICADO", texto: promo.texto });
  for (const p of c.pendencias || []) if (!/^(PROMO_INDISPONIVEL|SUBSIDIO_DESCONHECIDO|REBATE_AMBIGUO|FRETE_NAO_VERIFICADO)$/.test(p.codigo)) pendencias.push({ codigo: p.codigo, texto: p.texto });

  // ── Resultado (núcleo do Motor; subsídio comprovado UMA vez) ─────────────
  const freteAplica = !(k.frete && k.frete.aplicavel === false);
  const frete = freteAplica ? v(k.frete) : 0;
  let resultado = { calculavel: false, lucro: null, margem: null, margemPercent: null, confiavel: false, limiteInferior: false };
  if (res.calculavel) {
    const m = core.computeMargin({ price: comprador, cost: v(k.custo), taxRate: v(k.imposto), fixedFee: v(k.taxaFixa), commission: v(k.comissao), freight: frete, rebate: subsidio === null ? 0 : subsidio });
    if (m.computable && m.strict) {
      resultado = { calculavel: true, lucro: m.profit, margem: m.margin, margemPercent: r2(m.margin * 100), limiteInferior: subsidio === null, subsidioConsiderado: subsidio === null ? 0 : subsidio,
        confiavel: Boolean(c.margemConfiavel) && subsidio !== null };
    }
  }

  // ── Status simples ───────────────────────────────────────────────────────
  let status, motivoStatus;
  if (!resultado.calculavel) { status = STATUS.BLOQUEADO; motivoStatus = bloqueios.map((b) => b.texto).join(" ") || "Sem dados suficientes para calcular."; }
  else if (!resultado.confiavel) {
    // Subsídio só soma (≥ 0): limite inferior já na meta conclui OK — exceto se o preço mudou (base velha).
    if (resultado.limiteInferior && metaValor !== null && resultado.margem >= metaValor - EPS && c.margemConfiavel && promo.pendencia !== "PRECO_MUDOU") { status = STATUS.OK; motivoStatus = `Margem mínima ${pctBr(resultado.margem)} já na meta (o subsídio, se existir, só aumenta).`; }
    else { status = STATUS.MARGEM_DESCONHECIDA; motivoStatus = pendencias.map((p) => p.texto).join(" ") || "Margem não confiável."; }
  } else if (resultado.margem < 0) { status = STATUS.PREJUIZO; motivoStatus = `Prejuízo de ${brl(Math.abs(resultado.lucro))} por unidade.`; }
  else if (metaValor !== null && resultado.margem < metaValor - EPS) { status = STATUS.ABAIXO_DA_META; motivoStatus = `Margem ${pctBr(resultado.margem)} abaixo da meta de ${pctBr(metaValor)}.`; }
  else { status = STATUS.OK; motivoStatus = metaValor !== null ? `Margem ${pctBr(resultado.margem)} na meta.` : "Margem confiável (sem meta definida)."; }

  // ── Composição em cascata ───────────────────────────────────────────────
  const imposto = v(k.imposto);
  const descontoVendedor = promoAtiva && subsidio !== null ? cheio - comprador - subsidio : null;
  const cascata = [
    linha("precoCheio", "Preço cheio (controlado pelo vendedor)", "base", cheio, { fonte: k.precoCheio && k.precoCheio.fonte, confianca: k.precoCheio && k.precoCheio.confianca }),
    ...(promoAtiva ? [
      linha("descontoVendedor", "Desconto bancado pelo vendedor", "menos", descontoVendedor, { nota: subsidio === null ? "Depende de quem financia a promoção." : null }),
      linha("descontoMl", "Desconto bancado pelo Mercado Livre", "menos", subsidio, { nota: subsidio === null ? "Não comprovado." : null }),
    ] : []),
    linha("precoComprador", "Preço pago pelo comprador", "igual", comprador, { fonte: k.precoVigente && k.precoVigente.fonte, confianca: k.precoVigente && k.precoVigente.confianca }),
    linha("subsidioMl", "Subsídio/rebate do ML repassado ao vendedor", "mais", subsidio, { status: !promoAtiva ? "nao_aplicavel" : undefined, fonte: promo.fonte, nota: promoAtiva ? (promo.comprovado ? "Entra uma única vez." : "Não comprovado: não somado.") : null }),
    linha("receitaVendedor", "Receita reconhecida do vendedor", "igual", comprador !== null && subsidio !== null ? comprador + subsidio : null),
    linha("imposto", `Imposto${imposto !== null ? ` (${r2(imposto * 100)}%)` : ""}`, "menos", imposto !== null && comprador !== null ? comprador * imposto : null, { fonte: k.imposto && k.imposto.fonte }),
    linha("comissao", `Comissão${k.comissao && num(k.comissao.percentual) !== null ? ` (${r2(k.comissao.percentual * 100)}%)` : ""}`, "menos", v(k.comissao), { fonte: k.comissao && k.comissao.fonte, confianca: k.comissao && k.comissao.confianca }),
    linha("frete", "Frete", "menos", frete, { fonte: k.frete && k.frete.fonte, confianca: k.frete && k.frete.confianca, status: !freteAplica ? "nao_aplicavel" : undefined, nota: k.frete && (k.frete.texto || k.frete.nivel) || null }),
    linha("taxaFixa", "Taxa fixa", "menos", v(k.taxaFixa), { fonte: k.taxaFixa && k.taxaFixa.fonte }),
    linha("custo", "Custo do produto", "menos", v(k.custo), { fonte: k.custo && k.custo.fonte }),
    linha("lucro", resultado.limiteInferior ? "Lucro mínimo (sem subsídio)" : "Lucro por unidade", "igual", resultado.lucro),
  ];

  // ── Preço sugerido (só RECOTADO é liberado) ─────────────────────────────
  const q = normalizarRecotacao(recotacao);
  const precisaPreco = status === STATUS.ABAIXO_DA_META || status === STATUS.PREJUIZO;
  let sugerido = { status: "NAO_NECESSARIO", preco: null };
  if (precisaPreco) {
    const metaConfere = q && q.meta !== null && metaValor !== null && Math.abs(q.meta - metaValor) < 1e-4;
    if (q && q.ok && q.margemConfiavel && metaConfere && q.margem !== null && q.margem >= metaValor - 0.0005) {
      sugerido = { status: "RECOTADO", preco: q.preco, margem: q.margem, margemPercent: r2(q.margem * 100), lucro: q.lucro, comissao: q.comissao, frete: q.frete, freteNivel: q.freteNivel, freteConfianca: q.freteConfianca, recotadoEm: q.recotadoEm,
        texto: "Comissão e frete cotados no próprio preço sugerido (sem subsídio: preço novo não herda a promoção)." };
    } else {
      const pct = k.comissao ? num(k.comissao.percentual) : null, com = v(k.comissao);
      const fixaCom = pct !== null && com !== null && comprador !== null ? Math.max(0, com - pct * comprador) : 0;
      const alvo = metaValor !== null && res.calculavel ? core.computeTargetPrice({ cost: v(k.custo), fixedFee: (v(k.taxaFixa) || 0) + fixaCom, freight: frete, taxRate: imposto, commissionRate: pct, targetMargin: metaValor }) : { computable: false };
      sugerido = { status: "PRELIMINAR", preco: alvo.computable ? ceil2(alvo.price) : null,
        texto: q && !q.ok ? `Recotação não confirmou (${q.motivo || "sem cotação confiável"}): simulação preliminar, não usar.` : metaConfere === false && q ? "Recotado para outra meta: recotar para esta meta." : "Simulação preliminar com a comissão e o frete do preço atual: recotar antes de usar." };
    }
  }

  // ── Opções de ação (descritas; execução é outra camada, desligada por padrão) ─
  const acoes = [];
  const P = sugerido.preco;
  const modo = promoAtiva ? modoEscritaPromocao(promo.tipo) : null;
  if (precisaPreco && P !== null) {
    if (!promoAtiva) acoes.push({ tipo: "ALTERAR_PRECO", rotulo: `Alterar preço para ${brl(P)}`, precoAlvo: P, endpoint: "PATCH /anuncios-meli/:itemId/preco", suportada: true });
    else {
      const sair = q && q.cenarioSairPromo && num(q.cenarioSairPromo.margem) !== null ? q.cenarioSairPromo : null;
      if (promo.financiamento !== FINANCIAMENTO.COFINANCIADA && modo === "PRECO" && P < cheio - 0.009) acoes.push({ tipo: "ALTERAR_PRECO_PROMOCIONAL", rotulo: `Alterar o preço promocional para ${brl(P)}`, precoAlvo: P, promocaoId: promo.id, promocaoTipo: promo.tipo, endpoint: "POST /anuncios-meli/:itemId/promocoes/:promotionId/aplicar", suportada: Boolean(promo.id) });
      acoes.push({ tipo: "SAIR_DA_PROMOCAO", rotulo: "Sair da promoção", promocaoId: promo.id, promocaoTipo: promo.tipo, endpoint: "POST /anuncios-meli/:itemId/promocoes/:promotionId/sair",
        suportada: Boolean(modo && promo.id), motivoNaoSuportada: modo ? (promo.id ? null : "Promoção sem id na evidência.") : motivoTipoSemEscrita(promo.tipo),
        resultadoEsperado: sair ? { precoComprador: num(sair.preco), margem: num(sair.margem), margemPercent: r2(num(sair.margem) * 100), atingeMeta: metaValor !== null && sair.margem >= metaValor - EPS, recotado: true } : { precoComprador: cheio, recotado: false } });
      if (P >= cheio - 0.009 || promo.financiamento === FINANCIAMENTO.COFINANCIADA) acoes.push({ tipo: "ALTERAR_PRECO", rotulo: `Depois de sair, alterar o preço cheio para ${brl(P)}`, precoAlvo: P, endpoint: "PATCH /anuncios-meli/:itemId/preco", suportada: true, requerAntes: "SAIR_DA_PROMOCAO",
        nota: "O PATCH de preço é recusado com promoção ativa (o preço exibido seria o promocional)." });
    }
  }
  const precoMudou = q && q.precoMudouDesdeAuditoria ? q.precoMudouDesdeAuditoria : null;

  return {
    versao: VERSAO, itemId: item && item.itemId, status, motivoStatus, meta: metaInfo,
    precos: { cheio, comprador, promocionalVendedor: promoAtiva && promo.financiamento === FINANCIAMENTO.VENDEDOR ? comprador : null,
      // Campanha do próprio vendedor INICIADA que não forma o preço (outra promoção a deixa mais barata).
      campanhaVendedor: (() => { const oc = promoAtiva && Array.isArray(promo.iniciadas) ? promo.iniciadas.find((x) => !x.formaPreco && TIPOS_DO_VENDEDOR.has(x.tipo)) : null; return oc ? { id: oc.id, nome: oc.nome, tipoRotulo: oc.tipoRotulo, preco: oc.preco } : null; })() },
    promocao: { ativa: promoAtiva, iniciadas: Array.isArray(promo.iniciadas) ? promo.iniciadas : null, tipo: promo.tipo || null, tipoRotulo: promo.tipoRotulo || promo.tipo || null, id: promo.id || null, nome: promo.nome || null, financiamento: promo.financiamento, subsidio, comprovado: Boolean(promo.comprovado), texto: promo.texto || null, fonte: promo.fonte || null, modoEscrita: modo },
    cascata, resultado, bloqueios, pendencias, sugerido, acoes,
    precoMudou: precoMudou ? { ...precoMudou, texto: `Preço cheio mudou desde a auditoria (${brl(precoMudou.cheioAuditoria)} → ${brl(precoMudou.cheioAtual)}): reler antes de agir.` } : null,
    observadoEm: item && item.avaliadoEm || null,
  };
}

/**
 * Índice gravado no item (enriquecimento) para o SQL filtrar com as MESMAS regras
 * sem reprocessar o contrato: independe da meta (a meta entra na consulta).
 */
function indiceBancada(item) {
  const b = montarBancada(item, { meta: null });
  const c = (item && item.contrato) || {};
  return {
    promoAtiva: Boolean(b.promocao.ativa), calculavel: Boolean(b.resultado.calculavel), confiavel: Boolean(b.resultado.confiavel),
    margem: b.resultado.margem, limiteInferior: Boolean(b.resultado.limiteInferior), margemConfiavelBase: Boolean(c.margemConfiavel),
    promoPrecoMudou: (b.pendencias || []).some((p) => p.codigo === "PRECO_MUDOU"), // a mesma condição que impede o OK pelo limite inferior
  };
}

/** O que o operador faz a seguir, em uma frase (a lista mostra isto; o diagnóstico vai abaixo). */
function proximoPasso(b) {
  if (b.status === STATUS.OK) return "Nada a fazer: margem na meta.";
  if (b.status === STATUS.BLOQUEADO) { const x = (b.bloqueios || [])[0]; return x ? (x.resolveCom || x.texto) : "Completar os dados do anúncio."; }
  if (b.status === STATUS.MARGEM_DESCONHECIDA) {
    if (b.promocao && b.promocao.ativa && !b.promocao.comprovado) return "Ler as promoções do anúncio para comprovar quem paga o desconto.";
    return ((b.pendencias || [])[0] || {}).texto || "Recalcular a margem.";
  }
  const opcoes = (b.acoes || []).filter((a) => a.suportada !== false && !a.requerAntes).map((a) => a.rotulo);
  const depois = (b.acoes || []).find((a) => a.requerAntes && a.precoAlvo !== undefined);
  const base = (opcoes.length ? opcoes.join(" ou ") : "Rever o preço") + (depois ? ` e, depois, alterar o preço cheio para ${brl(depois.precoAlvo)}` : "");
  return base + (b.sugerido && b.sugerido.status === "RECOTADO" ? "." : " (recotar o preço sugerido antes).");
}

/** Linha LEVE da lista (mesma no servidor e no preview): o que a tabela mostra, sem o contrato. */
function linhaDaLista(x, b) {
  return {
    itemId: x.itemId, sku: x.sku || null, titulo: x.titulo || null, statusAnuncio: x.statusAnuncio || null,
    status: b.status, motivoStatus: b.motivoStatus, precoCheio: b.precos.cheio, precoComprador: b.precos.comprador,
    margemPercent: b.resultado.margemPercent, lucro: b.resultado.lucro, limiteInferior: Boolean(b.resultado.limiteInferior),
    promocao: b.promocao.ativa ? { tipoRotulo: b.promocao.tipoRotulo, financiamento: b.promocao.financiamento, subsidio: b.promocao.subsidio, comprovado: b.promocao.comprovado } : null,
    sugerido: { status: b.sugerido.status, preco: b.sugerido.preco }, acaoPrincipal: b.acoes[0] ? b.acoes[0].tipo : null, proximoPasso: proximoPasso(b),
    mudancaRecente: Boolean(x.historico && x.historico.mudancaRecente), ultimaMudancaEm: x.historico ? x.historico.ultimaMudancaEm || null : null,
    unidades30d: x.vendas30d ? x.vendas30d.unidades : null, precoMudou: Boolean(b.precoMudou), bloqueio: (b.bloqueios || [])[0] ? b.bloqueios[0].codigo : null, revisao: x.revisao || null, precoVisto: x.fingerprint ? x.fingerprint.precoVisto : null,
  };
}

/** Filtros simples da lista (abaixo da meta inclui prejuízo; desconhecida inclui bloqueado). */
function passaFiltro(b, filtro) {
  if (!filtro) return true;
  if (filtro === "abaixo_meta") return b.status === STATUS.ABAIXO_DA_META || b.status === STATUS.PREJUIZO;
  if (filtro === "prejuizo") return b.status === STATUS.PREJUIZO;
  if (filtro === "desconhecida") return b.status === STATUS.MARGEM_DESCONHECIDA || b.status === STATUS.BLOQUEADO;
  if (filtro === "promocao") return Boolean(b.promocao && b.promocao.ativa);
  if (filtro === "atencao") return b.status !== STATUS.OK;
  if (filtro === "na_meta") return b.status === STATUS.OK;
  return true;
}

module.exports = { montarBancada, passaFiltro, indiceBancada, linhaDaLista, metaDe, normalizarRecotacao, STATUS, FILTROS, VERSAO };
