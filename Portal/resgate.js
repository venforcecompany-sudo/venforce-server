/*
 * VenForce Resgate — experiência guiada (aprovada no protótipo D).
 *   Um anúncio:      Identificar → Entender → Resolver → Conferir.
 *   Vários anúncios: Selecionar → Estratégia → Simular → Exceções → Revisar.
 *
 * Regras da tela (não mudam com a UX):
 *   · Só EXIBE o que o servidor calculou (bancada resgate-bancada/1, contrato,
 *     recotação, pedidos da Central de Vendas). Nenhuma fórmula financeira aqui:
 *     as poucas contas da tela são de apresentação (proporção num gráfico,
 *     diferença entre dois resultados do servidor). Ausente = "—", nunca 0.
 *   · Simulação PRELIMINAR (sem ML): POST .../simular { preliminar:true } — o
 *     mesmo núcleo do servidor com a comissão e o frete de hoje. Sempre marcada
 *     "Preliminar". Só a RECOTAÇÃO (POST .../simular, somente GET no ML) ou o
 *     preço sugerido já recotado são mostrados como "Confirmado no Mercado Livre".
 *   · Ações reais: SOMENTE pelos endpoints existentes de /anuncios-meli, por um
 *     único caminho (executarAcao) que exige ações habilitadas pelo servidor,
 *     fora do preview, preço RECOTADO, releitura do preço atual igual ao visto e
 *     confirmação explícita no modal. Padrão: desligadas.
 *   · Propostas (individuais ou em lote) nunca são aplicadas: viram revisão
 *     registrada no servidor (POST .../revisao) e/ou ficam na lista local.
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.VFResgate = api; if (root.document) root.document.addEventListener("DOMContentLoaded", function () { api.iniciar(); }); }
})(typeof window !== "undefined" ? window : globalThis, function (root) {
  "use strict";

  var DEFAULT_API_BASE = "https://venforce-server.onrender.com";
  var STATUS = {
    OK: ["Na meta", "verde"], ABAIXO_DA_META: ["Abaixo da meta", "ambar"], PREJUIZO: ["Prejuízo", "vermelho"],
    MARGEM_DESCONHECIDA: ["Margem incerta", "cinza"], BLOQUEADO: ["Falta informação", "cinza"],
  };
  var ACAO_ROTULO = { ALTERAR_PRECO: "Alterar preço", ALTERAR_PRECO_PROMOCIONAL: "Alterar preço promocional", SAIR_DA_PROMOCAO: "Sair da promoção", PARTICIPAR: "Participar da promoção" };
  var ABAS = [["atencao", "Precisam de atenção"], ["prejuizo", "Em prejuízo"], ["desconhecida", "Falta informação"], ["na_meta", "Na meta"], ["", "Todos"]];
  var PASSOS = [[1, "Identificar", "situação"], [2, "Entender", "por que"], [3, "Resolver", "o que fazer"], [4, "Conferir", "antes de registrar"]];
  var WIZ = [[1, "Selecionar"], [2, "Estratégia"], [3, "Simular"], [4, "Exceções"], [5, "Revisar"]];
  var ESTRATEGIAS = [
    ["SAIR_CAMPANHA", "Sair das campanhas próprias e ajustar o preço cheio", "Para anúncios em que o desconto é todo seu. O preço cheio vai para a meta."],
    ["AJUSTAR_PROMOCIONAL", "Ajustar o preço promocional da campanha própria", "Continua na campanha, com um preço promocional maior."],
    ["ALTERAR_CHEIO", "Alterar o preço cheio", "Para anúncios sem promoção."],
  ];
  var EXCECAO = {
    BLOQUEADO: ["Falta informação", "Não dá para calcular: resolva no modo Um anúncio."], MARGEM_INCERTA: ["Margem incerta", "É preciso confirmar quanto o Mercado Livre paga antes."],
    PRECO_MUDOU: ["Preço mudou", "O preço mudou desde a auditoria: precisa ser relido."], ACIMA_DO_TETO: ["Aumento acima do limite", "Você decide: incluir mesmo assim ou deixar de fora."],
    NAO_SE_APLICA: ["A estratégia não se aplica", "Escolha outra estratégia para estes anúncios."], SEM_PRECO: ["Meta inalcançável", "Os custos não permitem chegar à meta."], NA_META: ["Já estão na meta", "Nada a fazer."],
  };
  var TIPOS_VENDEDOR = { SELLER_CAMPAIGN: 1, PRICE_DISCOUNT: 1 };

  // ── Formatação (ausente = "—", nunca 0) ─────────────────────────────────
  function vazio(v) { return v === null || v === undefined || v === "" || (typeof v === "number" && !isFinite(v)); }
  function moeda(v) { return vazio(v) ? "—" : (Number(v) < 0 ? "−" : "") + "R$ " + Math.abs(Number(v)).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function pct(v, casas) { if (vazio(v)) return "—"; var c = casas === undefined ? 2 : casas; return (Number(v) < 0 ? "−" : "") + Math.abs(Number(v)).toLocaleString("pt-BR", { minimumFractionDigits: c, maximumFractionDigits: c }) + "%"; }
  function inteiro(v) { return vazio(v) ? "—" : Number(v).toLocaleString("pt-BR"); }
  function data(v) { if (vazio(v)) return "—"; var d = new Date(v); return isNaN(d.getTime()) ? "—" : d.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }); }
  function esc(s) { return String(s === null || s === undefined ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function curto(t, n) { t = String(t || ""); return t.length > n ? t.slice(0, n - 1) + "…" : t; }
  function r2(v) { return Math.round(v * 100) / 100; }
  function lerNumero(texto) { var s = String(texto === null || texto === undefined ? "" : texto).trim().replace(/\s|R\$/g, ""); if (!s) return null; if (s.indexOf(",") >= 0) s = s.replace(/\./g, "").replace(",", "."); var n = Number(s); return isFinite(n) && n > 0 ? n : null; }
  function lerPrecos(texto) { return String(texto || "").split(/[;\s]+/).map(lerNumero).filter(function (n) { return n !== null; }).slice(0, 8); }
  function buildQuery(params) {
    var q = new URLSearchParams();
    Object.keys(params || {}).forEach(function (k) { var v = params[k]; if (v === null || v === undefined || v === "" || v === false) return; q.set(k, v === true ? "1" : String(v)); });
    var s = q.toString();
    return s ? "?" + s : "";
  }

  // ── Leitura da bancada do servidor (nada é recalculado) ─────────────────
  function linhaCascata(b, k) { return ((b && b.cascata) || []).filter(function (x) { return x.chave === k; })[0] || null; }
  function cv(b, k) { var l = linhaCascata(b, k); return l && l.status === "ok" ? l.valor : null; }
  function promo(b) { return b && b.promocao && b.promocao.ativa ? b.promocao : null; }
  function doVendedor(b) { var p = promo(b); return Boolean(p && p.financiamento === "VENDEDOR_100"); }
  function cofinanciada(b) { var p = promo(b); return Boolean(p && p.financiamento === "ML_COFINANCIA" && p.comprovado); }
  function incerta(b) { var p = promo(b); return Boolean(p && !p.comprovado); }
  function margem(b) { return b && b.resultado && b.resultado.calculavel ? b.resultado.margemPercent : null; }
  function lucro(b) { return b && b.resultado && b.resultado.calculavel ? b.resultado.lucro : null; }
  function minimo(b) { return Boolean(b && b.resultado && b.resultado.limiteInferior); }
  function formaPreco(b) { var p = promo(b); return p && p.iniciadas ? p.iniciadas.filter(function (x) { return x.formaPreco; })[0] || null : null; }
  function nomePromo(p) { return p ? (p.nome ? "“" + p.nome + "”" : String(p.tipoRotulo || "promoção").toLowerCase()) : ""; }
  function recotado(b) { return b && b.sugerido && b.sugerido.status === "RECOTADO" ? b.sugerido : null; }

  /** Situação em palavras + cor (cor só quando indica algo real). Aceita a bancada completa ou a linha da lista. */
  function situacao(x) {
    var st = x.status, m = x.resultado ? margem(x) : x.margemPercent, L = x.resultado ? lucro(x) : x.lucro, lim = x.resultado ? minimo(x) : x.limiteInferior;
    var s = STATUS[st] || [st || "—", "cinza"];
    var curtoTxt = st === "BLOQUEADO" ? textoBloqueio(x.bloqueios ? (x.bloqueios[0] || {}).codigo : x.bloqueio).curto
      : vazio(m) ? "Margem desconhecida" : m < 0 ? "Perde " + moeda(-L) + " por venda" : lim ? "Pelo menos " + pct(m) + " de margem" : "Lucra " + moeda(L) + " · " + pct(m);
    return { rotulo: s[0], cor: s[1], curto: curtoTxt };
  }
  var BLOQ = {
    FRETE_DESCONHECIDO: { curto: "Frete desconhecido", texto: "Não conseguimos calcular o frete deste anúncio com segurança." },
    CUSTO_AUSENTE: { curto: "Sem custo do produto", texto: "O custo deste produto não está na base de custos do cliente." },
    COMISSAO_AUSENTE: { curto: "Comissão desconhecida", texto: "Não conseguimos confirmar a comissão do Mercado Livre deste anúncio." },
    IMPOSTO_AUSENTE: { curto: "Sem imposto", texto: "A alíquota de imposto não está na base de custos." },
    TAXA_FIXA_AUSENTE: { curto: "Sem taxa fixa", texto: "A taxa fixa não está na base de custos." },
    PRECO_AUSENTE: { curto: "Sem preço", texto: "O preço atual do anúncio não foi lido." },
  };
  function textoBloqueio(codigo) { return BLOQ[codigo] || { curto: "Falta informação", texto: "Falta informação para calcular." }; }

  /** Origem de cada valor em palavras simples (o termo técnico continua em Evidências). */
  function origem(f) {
    f = String(f || "");
    if (/base de custos/.test(f)) return "da base de custos do cliente";
    if (/recotado|ao vivo/.test(f) && /listing_prices/.test(f)) return "tabela de comissões do Mercado Livre, consultada agora";
    if (/listing_prices/.test(f)) return "tabela de comissões do Mercado Livre";
    if (/item_id/.test(f)) return "cotação do Mercado Livre para este anúncio";
    if (/historic/.test(f)) return "estimado pelas medidas de envios anteriores";
    if (/SELLER_PACKAGE|declarad/.test(f)) return "estimado pelas medidas informadas no anúncio";
    if (/shipments\/costs|senders|custo cobrado/.test(f)) return "média do que o Mercado Livre cobrou em envios anteriores";
    if (/sale_price|snapshot do Motor/.test(f)) return "preço lido no Mercado Livre";
    if (/Promo Snapshot|seller-promotions|Leitura ao ML/.test(f)) return "promoções lidas no Mercado Livre";
    return f ? "detalhe técnico em Evidências" : "sem fonte";
  }
  function selo(c) {
    if (!c) return { cls: "blq", txt: "sem dado" };
    if (c.status === "desconhecido" || vazio(c.valor)) return { cls: "blq", txt: "desconhecido" };
    if (c.status === "estimado" || c.estimado || (c.confianca && c.confianca !== "alta" && c.confianca !== null && c.confianca !== "nao_aplicavel")) return { cls: "est", txt: "estimado" };
    return { cls: "conf", txt: "verificado" };
  }
  // Selos DIFERENTES para validações diferentes (nunca o mesmo texto):
  //  · frete do preço ATUAL (evidência da auditoria): cotado no ML / estimado / desconhecido;
  //  · PREÇO sugerido ou simulado: recotado no ML (comissão e frete cotados NAQUELE preço) / preliminar.
  function seloFrete(fr) {
    if (!fr || fr.status === "desconhecido" || vazio(fr.valor)) return { cls: "blq", txt: "frete desconhecido" };
    if (fr.status === "nao_aplicavel") return { cls: "blq", txt: "sem frete" };
    if (fr.nivel === "cotado_ml" && fr.confianca === "alta") return { cls: "conf", txt: "frete cotado no ML (preço atual)" };
    if (fr.nivel === "cotado_ml_nao_verificado") return { cls: "est", txt: "frete cotado, não verificado" };
    return { cls: "est", txt: "frete estimado" };
  }
  function seloPreco(tipo) { return tipo === "RECOTADO" || tipo === "CONFIRMADO" ? { cls: "rec", txt: "preço recotado no ML" } : { cls: "pre", txt: "preço preliminar" }; }

  // ── ENTENDER: o problema em português simples ───────────────────────────
  /** @param det {item,bancada} · @param prelim mapa preço → simulação preliminar já pedida ao servidor */
  function entender(det, prelim, meta) {
    var b = det.bancada || {}, item = det.item || {}, p = promo(b), f = formaPreco(b), oc = b.precos && b.precos.campanhaVendedor;
    var P = b.precos ? b.precos.comprador : null, cheio = b.precos ? b.precos.cheio : null, m = margem(b), L = lucro(b), frases = [], manchete;
    if (b.status === "BLOQUEADO") manchete = "Ainda não dá para saber se este anúncio dá lucro.";
    else if (m !== null && m < 0) manchete = "Você perde " + moeda(-L) + " a cada venda deste anúncio.";
    else if (minimo(b)) manchete = "Você lucra pelo menos " + moeda(L) + " por venda — pode ser mais, mas não dá para comprovar.";
    else if (b.status === "ABAIXO_DA_META") manchete = "Você lucra " + moeda(L) + " por venda (" + pct(m) + "), abaixo da sua meta de " + pct(meta, 0) + ".";
    else manchete = "Tudo certo: você lucra " + moeda(L) + " por venda (" + pct(m) + ").";
    if (p) {
      var ehVend = TIPOS_VENDEDOR[p.tipo];
      frases.push({ t: "O comprador paga " + moeda(P) + " por causa da promoção " + nomePromo(f || p) + (ehVend ? ", criada por você." : ", do Mercado Livre.") + " O preço cheio é " + moeda(cheio) + "." });
      if (oc) frases.push({ t: "Você também tem a campanha " + nomePromo(oc) + " a " + moeda(oc.preco) + ", mas não é ela que define o preço: a outra promoção deixa o anúncio " + moeda(r2(oc.preco - P)) + " mais barato." });
      var dv = cv(b, "descontoVendedor"), dm = cv(b, "descontoMl");
      if (doVendedor(b)) frases.push({ t: "O desconto de " + moeda(dv) + " sai inteiro do seu lucro: o Mercado Livre não ajuda nesta promoção.", c: b.status !== "OK" ? "destaque" : "" });
      else if (cofinanciada(b)) frases.push({ t: "Do desconto, o Mercado Livre devolve " + moeda(p.subsidio) + " por venda e você banca " + moeda(dv) + ". Essa devolução já está na conta, uma única vez." });
      else frases.push({ t: "Esta promoção não informa quanto o Mercado Livre paga do desconto. Por segurança, contamos como se ele não pagasse nada.", c: "destaque" });
      void dm;
    } else if (P !== null) frases.push({ t: "Não há promoção: o comprador paga o preço cheio de " + moeda(P) + "." });
    if (b.status === "BLOQUEADO") {
      (b.bloqueios || []).forEach(function (x) { frases.push({ t: textoBloqueio(x.codigo).texto, c: "alerta" }); });
    } else if (b.status === "ABAIXO_DA_META" || b.status === "PREJUIZO") {
      var semDesc = doVendedor(b) && prelim && prelim[String(cheio)];
      if (semDesc && semDesc.resultado && semDesc.resultado.calculavel) frases.push({ t: "Sem esse desconto, vendendo a " + moeda(cheio) + ", você lucraria cerca de " + moeda(semDesc.resultado.lucro) + " por venda (" + pct(semDesc.resultado.margemPercent) + ") — estimativa preliminar." });
      var maior = maiorCusto(b);
      if (maior && P) frases.push({ t: "O que mais pesa no preço é " + maior.rotulo + ": " + moeda(maior.valor) + " de cada " + moeda(P) + " (" + pct(maior.valor / P * 100, 0) + ")." });
      var s = b.sugerido || {};
      if (s.preco) frases.push({ t: "Para chegar a " + pct(meta, 0) + ", o preço precisaria ser " + moeda(s.preco) + (s.status === "RECOTADO" ? " — preço já recotado no Mercado Livre." : " (estimativa preliminar).") });
    }
    if (b.precoMudou) frases.push({ t: b.precoMudou.texto, c: "alerta" });
    return { manchete: manchete, frases: frases };
  }
  function maiorCusto(b) {
    var c = [["o custo do produto", "custo"], ["a comissão do Mercado Livre", "comissao"], ["o frete", "frete"], ["o imposto", "imposto"]].map(function (x) { return { rotulo: x[0], valor: cv(b, x[1]) }; }).filter(function (x) { return x.valor !== null; });
    c.sort(function (a, z) { return z.valor - a.valor; }); return c[0] || null;
  }
  /** Para onde vai cada venda — proporções só para o gráfico, a partir da cascata do servidor. */
  function paraOndeHtml(b) {
    var P = b.precos && b.precos.comprador, sub = cofinanciada(b) ? promo(b).subsidio : 0, L = lucro(b);
    var partes = [["Custo do produto", "custo", "#7a5aa6"], ["Comissão", "comissao", "#a893c9"], ["Frete", "frete", "#c9bcdf"], ["Imposto", "imposto", "#dcd3ea"], ["Taxa fixa", "taxaFixa", "#e9e3f2"]].map(function (x) { return { r: x[0], v: cv(b, x[1]), cor: x[2] }; });
    if (!P || L === null || partes.some(function (x) { return x.v === null; })) return "";
    partes = partes.filter(function (x) { return x.v > 0; });
    var total = P + (sub || 0), maior = partes.slice().sort(function (a, z) { return z.v - a.v; })[0];
    return '<div class="rg-onde"><h3>Para onde vai cada venda de ' + moeda(P) + (sub ? " (+ " + moeda(sub) + " do Mercado Livre)" : "") + '</h3><div class="rg-onde__barra">' +
      partes.map(function (x) { return '<span style="width:' + (x.v / total * 100) + "%;background:" + x.cor + '" title="' + esc(x.r) + '"></span>'; }).join("") + (L > 0 ? '<span class="rg-onde__lucro" style="width:' + (L / total * 100) + '%"></span>' : "") +
      '</div><div class="rg-onde__leg">' + partes.map(function (x) { return '<span class="' + (x === maior ? "is-forte" : "") + '"><i style="background:' + x.cor + '"></i>' + esc(x.r) + " " + moeda(x.v) + "</span>"; }).join("") +
      '<span class="is-forte"><i class="' + (L > 0 ? "rg-i-lucro" : "rg-i-prej") + '"></i>' + (L >= 0 ? "Seu lucro " : "Prejuízo ") + moeda(L) + "</span></div></div>";
  }

  // ── RESOLVER: só as ações compatíveis com o anúncio ─────────────────────
  function opcoes(det, meta) {
    var b = det.bancada || {}, p = promo(b), a = [], abaixo = b.status === "ABAIXO_DA_META" || b.status === "PREJUIZO", oc = b.precos && b.precos.campanhaVendedor;
    if (b.status === "BLOQUEADO") {
      a.push({ id: "completar", tipo: "tarefa", titulo: "Completar a informação que falta", desc: (b.bloqueios || []).map(function (x) { return textoBloqueio(x.codigo).texto; }).join(" "), passos: (b.bloqueios || []).map(function (x) { return x.resolveCom || x.texto; }), rec: true });
      a.push({ id: "manter", tipo: "manter", titulo: "Deixar como está por enquanto", desc: "Nada muda no anúncio." });
      return a;
    }
    if (incerta(b)) {
      a.push({ id: "confirmar", tipo: "tarefa", titulo: "Confirmar quanto o Mercado Livre paga", desc: "A promoção " + nomePromo(formaPreco(b) || p) + " não informa a participação do Mercado Livre.", passos: ["Ler a promoção novamente no Mercado Livre (só leitura): use “Confirmar no Mercado Livre” abaixo.", "Se a participação aparecer, a margem é recalculada com ela; se não, continua no pior caso."], rec: b.status !== "OK", recotar: true });
      a.push({ id: "pior", tipo: "preco", titulo: "Ajustar o preço considerando o pior caso", desc: "Simula sem nenhuma ajuda do Mercado Livre.", cen: "sem" });
      a.push({ id: "manter", tipo: "manter", titulo: "Deixar como está", desc: b.status === "OK" ? "Mesmo no pior caso, já está na meta." : "Nada muda no anúncio.", rec: b.status === "OK" });
      return a;
    }
    if (doVendedor(b)) {
      a.push({ id: "sair", tipo: "preco", titulo: "Sair da campanha e ajustar o preço cheio", desc: "O anúncio volta ao preço cheio (" + moeda(b.precos.cheio) + "), que você ajusta para a meta.", cen: "sem", base: b.precos.cheio, acao: "SAIR_DA_PROMOCAO", rec: abaixo });
      if (p.modoEscrita === "PRECO") a.push({ id: "promo", tipo: "preco", titulo: "Reduzir o desconto da campanha", desc: "Continua na campanha " + nomePromo(p) + ", com um preço promocional maior.", cen: "sem", acao: "ALTERAR_PRECO_PROMOCIONAL" });
      a.push({ id: "comparar", tipo: "comparar", titulo: "Comparar promoções", desc: "Veja se outra promoção, com ajuda do Mercado Livre, rende mais." });
    } else if (cofinanciada(b)) {
      a.push({ id: "comparar", tipo: "comparar", titulo: "Comparar promoções", desc: "Veja, lado a lado, quanto você ganha em cada promoção — com e sem a ajuda do Mercado Livre.", rec: abaixo });
      a.push({ id: "sair", tipo: "preco", titulo: "Sair da promoção " + nomePromo(p), desc: (oc ? "O comprador passa a pagar o preço da sua campanha " + nomePromo(oc) + " (" + moeda(oc.preco) + "), que você pode ajustar." : "O anúncio volta ao preço cheio, que você ajusta.") + " Você perde a ajuda de " + moeda(p.subsidio) + " do Mercado Livre.", cen: "sem", base: oc ? oc.preco : b.precos.cheio, acao: "SAIR_DA_PROMOCAO" });
      a.push({ id: "manter", tipo: "manter", titulo: "Continuar na promoção", desc: p.modoEscrita === "PRECO" ? "Nada muda; hoje rende " + pct(margem(b)) + "." : "Nesta promoção o Mercado Livre define o preço: dá para continuar ou sair, não para mudar o valor. Hoje rende " + pct(margem(b)) + "." });
    } else {
      a.push({ id: "cheio", tipo: "preco", titulo: "Alterar o preço", desc: "Ajuste o preço do anúncio para a meta.", cen: "sem", acao: "ALTERAR_PRECO", rec: abaixo });
      a.push({ id: "comparar", tipo: "comparar", titulo: "Comparar promoções disponíveis", desc: "Veja se alguma promoção do Mercado Livre compensa." });
    }
    if (!a.some(function (x) { return x.id === "manter"; })) a.push({ id: "manter", tipo: "manter", titulo: "Deixar como está", desc: abaixo ? "Nada muda; continua abaixo da meta." : "Já está na meta.", rec: !abaixo });
    void meta;
    return a;
  }

  // ── Fragmentos de tela (puros, testáveis) ───────────────────────────────
  function situacaoHtml(s) { return '<span class="rg-sit rg-sit--' + s.cor + '"><span class="rg-ponto rg-ponto--' + s.cor + '"></span>' + esc(s.rotulo) + "</span>"; }
  function itemListaHtml(x) {
    var b = x.bancada || {}, s = situacao(b);
    return '<li class="rg-item" tabindex="0" data-rg-item="' + esc(x.itemId) + '"><span class="rg-ponto rg-ponto--' + s.cor + '"></span><div class="rg-item__meio"><div class="rg-item__t">' + esc(x.titulo || x.itemId) + '</div><div class="rg-item__s">' + esc(x.itemId) + (x.sku ? " · " + esc(x.sku) : "") + " · " + moeda(b.precoComprador) + (b.unidades30d ? " · " + inteiro(b.unidades30d) + " vendas/mês" : "") + (b.mudancaRecente ? " · alterado recentemente" : "") + '</div></div><div class="rg-item__r"><strong>' + esc(s.rotulo) + "</strong><span>" + esc(s.curto) + "</span></div></li>";
  }
  function passosHtml(passo, liberado) {
    return '<nav class="rg-passos" aria-label="Etapas">' + PASSOS.map(function (p) { return '<button type="button" class="rg-passo ' + (passo === p[0] ? "is-ativo" : passo > p[0] ? "is-feito" : "") + '" data-rg-passo="' + p[0] + '"' + (p[0] > liberado ? " disabled" : "") + "><b>" + p[0] + ". " + p[1] + "</b><span>" + p[2] + "</span></button>"; }).join("") + "</nav>";
  }
  function identificarHtml(det, meta) {
    var b = det.bancada || {}, m = margem(b), L = lucro(b), p = promo(b), item = det.item || {}, fr = item.contrato && item.contrato.componentes && item.contrato.componentes.frete;
    var nota = b.status === "BLOQUEADO" ? "Não calculado: falta informação." : minimo(b) ? "Valor mínimo: pode ser maior." : fr && fr.status !== "ok" ? "Projetado, com frete estimado." : "Projetado com os valores de hoje.";
    var v = item.vendas30d ? item.vendas30d.unidades : null;
    return '<section class="rg-cartao"><div class="rg-trio"><div><small>O comprador paga</small><strong class="rg-n">' + moeda(b.precos && b.precos.comprador) + "</strong><span>" + (p ? "com promoção · cheio " + moeda(b.precos.cheio) : "preço cheio") + "</span></div>" +
      '<div><small>Seu lucro por venda</small><strong class="rg-n ' + (L < 0 ? "rg-neg" : "") + '">' + (L === null ? "?" : (minimo(b) ? "≥ " : "") + moeda(L)) + "</strong><span>" + esc(nota) + "</span></div>" +
      '<div><small>Margem</small><strong class="rg-n ' + (m < 0 ? "rg-neg" : "") + '">' + (m === null ? "?" : (minimo(b) ? "≥ " : "") + pct(m)) + "</strong><span>meta " + pct(meta, 0) + (v ? " · " + inteiro(v) + " vendas em 30 dias" : " · sem vendas em 30 dias") + "</span></div></div>" +
      '<p class="rg-frase">' + esc(entender(det, null, meta).manchete) + "</p></section>";
  }
  function entenderHtml(det, prelim, meta) {
    var x = entender(det, prelim, meta), b = det.bancada || {};
    return '<section class="rg-cartao"><p class="rg-manchete">' + esc(x.manchete) + '</p><ul class="rg-explica">' + x.frases.map(function (f, k) { return '<li class="' + (f.c ? "is-" + f.c : "") + '"><i>' + (k + 1) + "</i><span>" + esc(f.t) + "</span></li>"; }).join("") + "</ul>" +
      (b.resultado && b.resultado.calculavel ? paraOndeHtml(b) : "") +
      '<div class="rg-links"><button class="rg-link" type="button" data-rg-painel="calculo">Entender cálculo</button><button class="rg-link" type="button" data-rg-painel="evidencias">Evidências</button><button class="rg-link" type="button" data-rg-painel="pedidos">Pedidos reais</button></div></section>';
  }
  /** Resultado de um preço (preliminar do servidor, recotação real, ou sugerido já recotado). */
  function normalizarSim(s, tipo) {
    if (!s) return null;
    var res = s.resultado || {};
    return { preco: s.preco, tipo: tipo, calculavel: tipo === "CONFIRMADO" && s.margemPercent !== undefined ? true : Boolean(res.calculavel), margemPercent: s.margemPercent !== undefined ? s.margemPercent : res.margemPercent, lucro: s.lucro !== undefined && typeof s.lucro === "number" ? s.lucro : res.lucro,
      comissao: s.comissao && typeof s.comissao === "object" ? s.comissao : { valor: s.comissao, fonte: "listing_prices (recotado no preço simulado)", status: "ok", confianca: "alta" },
      frete: s.frete && typeof s.frete === "object" ? s.frete : { valor: s.frete, nivel: s.freteNivel, confianca: s.freteConfianca, status: s.freteConfianca && s.freteConfianca !== "alta" ? "estimado" : "ok" },
      bloqueios: s.bloqueios || [], avisos: s.avisos || [], em: s.recotadoEm || s.observadoEm || null };
  }
  function antesDepoisHtml(det, r, meta) {
    var b = det.bancada || {}, m0 = margem(b), L0 = lucro(b), v = det.item && det.item.vendas30d ? det.item.vendas30d.unidades : 0;
    if (!r) return '<p class="rg-mudo">Informe um preço para simular.</p>';
    if (!r.calculavel) return '<div class="rg-selo rg-selo--blq"><b>Não é possível simular</b>' + esc(((r.bloqueios || [])[0] || {}).texto || "Falta informação para calcular.") + "</div>";
    var dL = L0 === null ? null : r2(r.lucro - L0);
    var selo = r.tipo === "CONFIRMADO" ? '<div class="rg-selo rg-selo--ok"><b>✓ Preço recotado no Mercado Livre</b>Comissão e frete foram cotados neste preço' + (r.em ? " em " + data(r.em) : "") + ".</div>"
      : '<div class="rg-selo rg-selo--pre"><b>Preço preliminar</b>' + esc((r.avisos || []).join(" ") || "Comissão e frete mantidos como hoje: confirme no Mercado Livre antes de aplicar.") + "</div>";
    return '<div class="rg-ad"><div class="rg-ad__c"><small>Hoje</small><div class="rg-ad__g rg-n ' + (m0 < 0 ? "rg-neg" : "") + '">' + (m0 === null ? "?" : (minimo(b) ? "≥ " : "") + pct(m0)) + '</div><div class="rg-ad__m">' + (L0 === null ? "lucro desconhecido" : moeda(L0) + " por venda") + " · " + moeda(b.precos && b.precos.comprador) + '</div></div><span class="rg-ad__seta">→</span>' +
      '<div class="rg-ad__c rg-ad__c--depois"><small>Com ' + moeda(r.preco) + '</small><div class="rg-ad__g rg-n ' + (r.margemPercent < 0 ? "rg-neg" : "") + '">' + pct(r.margemPercent) + '</div><div class="rg-ad__m">' + moeda(r.lucro) + " por venda</div></div></div>" +
      (dL !== null ? '<p class="rg-ganho"><strong class="' + (dL >= 0 ? "rg-pos" : "rg-neg") + '">' + (dL >= 0 ? "+" : "") + moeda(dL) + "</strong> por venda" + (v ? " · em 30 dias, vendendo o mesmo (" + inteiro(v) + "): <strong>" + (dL >= 0 ? "+" : "") + moeda(r2(dL * v)) + "</strong>" : "") + "</p>" : "") +
      (r.margemPercent < meta ? '<p class="rg-mudo">Ainda abaixo da meta de ' + pct(meta, 0) + ".</p>" : "") + selo +
      '<p class="rg-mudou">Comissão ' + moeda(cv(b, "comissao")) + " → " + moeda(r.comissao && r.comissao.valor) + " · Frete " + moeda(cv(b, "frete")) + " → " + moeda(r.frete && r.frete.valor) + (cofinanciada(b) ? " · a ajuda do Mercado Livre não passa para o preço novo" : "") + "</p>";
  }
  /** Linhas de promoção no agrupamento da tela de Anúncios. `vivas` = GET /anuncios-meli/:id/promocoes; sem elas, as iniciadas da auditoria. */
  function linhasPromocao(det, vivas, prelim) {
    var b = det.bancada || {}, out = [];
    if (vivas && vivas.length) {
      vivas.forEach(function (p, k) {
        var ativa = p.statusExibicao === "ATIVA", participa = p.status === "started" || p.status === "active";
        var grupo = ativa ? "ativa" : participa ? "participa" : p.status === "candidate" && (p.modoEscrita === "PRECO" || p.modoEscrita === "ACEITE") ? "pode" : "ml";
        var vr = p.voceRecebe || {};
        out.push({ chave: "v" + k, grupo: grupo, nome: (p.nome ? p.nome + " · " : "") + (p.tipoLabel || p.tipo), tipo: p.tipo, id: p.id, preco: p.precoFinal, modoEscrita: p.modoEscrita || null,
          ajuda: vazio(p.subsidioMl) ? (TIPOS_VENDEDOR[p.tipo] ? "desconto todo seu" : "o Mercado Livre não informa quanto paga") : "o Mercado Livre paga " + moeda(p.subsidioMl) + " por venda",
          margem: vr.computable ? vr.marginPercent : null, lucro: vr.computable ? vr.profit : null, minimo: vazio(p.subsidioMl) && !TIPOS_VENDEDOR[p.tipo], fonte: "calculado pelo servidor" });
      });
      return out;
    }
    var ini = (promo(b) && promo(b).iniciadas) || [];
    ini.forEach(function (x, k) {
      var s = x.formaPreco ? null : prelim && prelim[String(x.preco)];
      out.push({ chave: "i" + k, grupo: x.formaPreco ? "ativa" : "participa", nome: (x.nome ? x.nome + " · " : "") + String(x.tipoRotulo || x.tipo).toLowerCase(), tipo: x.tipo, id: x.id, preco: x.preco, modoEscrita: null,
        ajuda: x.formaPreco ? (cofinanciada(b) ? "o Mercado Livre paga " + moeda(promo(b).subsidio) + " por venda" : TIPOS_VENDEDOR[x.tipo] ? "desconto todo seu" : "o Mercado Livre não informa quanto paga") : (TIPOS_VENDEDOR[x.tipo] ? "desconto todo seu" : "o Mercado Livre não informa quanto paga"),
        margem: x.formaPreco ? margem(b) : s && s.resultado && s.resultado.calculavel ? s.resultado.margemPercent : null, lucro: x.formaPreco ? lucro(b) : s && s.resultado ? s.resultado.lucro : null,
        minimo: x.formaPreco ? minimo(b) : !TIPOS_VENDEDOR[x.tipo], forma: x.formaPreco, fonte: x.formaPreco ? "auditado" : "preliminar" });
    });
    return out;
  }
  var GRUPOS_PROMO = [["ativa", "Ativa agora", "É ela que forma o preço de hoje"], ["participa", "Você já participa", "Inscrita, mas não forma o preço agora"], ["pode", "Pode participar", "Simule e proponha por aqui"], ["ml", "Só pelo Mercado Livre", "Dá para simular; a inscrição é no painel do Mercado Livre"]];
  function compararHtml(linhas, sel, temVivas, podeLerVivas) {
    if (!linhas.length) return '<p class="rg-mudo">' + (podeLerVivas ? 'Nenhuma promoção carregada. <button class="rg-link" type="button" data-rg-ler-promos>Ler promoções no Mercado Livre</button>' : "Sem lista de promoções para este anúncio neste ambiente.") + "</p>";
    return (temVivas ? "" : '<p class="rg-mudo">Promoções iniciadas no anúncio, pela auditoria.' + (podeLerVivas ? ' <button class="rg-link" type="button" data-rg-ler-promos>Ler todas as disponíveis no Mercado Livre</button>' : "") + "</p>") +
      GRUPOS_PROMO.filter(function (g) { return linhas.some(function (x) { return x.grupo === g[0]; }); }).map(function (g) {
        return '<div class="rg-gpromo"><div class="rg-gpromo__t"><b>' + g[1] + '</b> <span class="rg-mudo">' + g[2] + "</span></div>" + linhas.filter(function (x) { return x.grupo === g[0]; }).map(function (x) {
          return '<button type="button" class="rg-opcao rg-opcao--promo' + (sel === x.chave ? " is-ativo" : "") + '" data-rg-promo-sel="' + esc(x.chave) + '"><span class="rg-radio"></span><div><strong>' + esc(x.nome) + "</strong><span>Comprador paga " + moeda(x.preco) + " · " + esc(x.ajuda) + '</span></div><div class="rg-opcao__dir"><b class="rg-n">' + (x.margem === null ? "—" : (x.minimo ? "≥ " : "") + pct(x.margem)) + '</b><span class="rg-mudo">' + (x.lucro === null || x.lucro === undefined ? "" : moeda(x.lucro) + " · ") + esc(x.fonte) + "</span></div></button>"; }).join("") + "</div>"; }).join("");
  }
  function painelCalculoHtml(b) {
    var OP = { base: "", menos: "−", mais: "+", igual: "=" };
    var ROT = { precoCheio: "Preço cheio", descontoVendedor: "Desconto bancado por você", descontoMl: "Desconto bancado pelo Mercado Livre", precoComprador: "O comprador paga", subsidioMl: "O Mercado Livre devolve a você", receitaVendedor: "Você recebe", lucro: "Seu lucro por venda" };
    return '<p class="rg-mudo">A conta completa, linha por linha. A ajuda do Mercado Livre entra uma única vez.</p><ul class="rg-calc">' + (b.cascata || []).map(function (l) {
      var c = selo(l), v = l.status === "ok" ? moeda(l.valor) : l.status === "nao_aplicavel" ? "não se aplica" : vazio(l.valor) ? "?" : "≈ " + moeda(l.valor);
      return '<li class="' + (l.chave === "lucro" ? "is-total" : l.operacao === "igual" ? "is-sub" : "") + '" data-rg-linha="' + esc(l.chave) + '"><span class="rg-calc__op">' + (OP[l.operacao] || "") + '</span><span class="rg-calc__t">' + esc(ROT[l.chave] || l.rotulo) + (l.status === "nao_aplicavel" ? "" : ' <span class="rg-marca rg-marca--' + c.cls + '">' + c.txt + "</span>") + '</span><span class="rg-calc__v rg-n">' + v + "</span>" + (l.fonte || l.nota ? '<span class="rg-calc__o">' + esc(l.fonte ? origem(l.fonte) : "") + (l.nota ? (l.fonte ? " · " : "") + esc(l.nota) : "") + "</span>" : "") + "</li>"; }).join("") + "</ul>" +
      (minimo(b) ? '<p class="rg-mudo">Como a ajuda do Mercado Livre não foi comprovada, ela foi contada como zero: o lucro real pode ser maior.</p>' : "");
  }
  function painelEvidenciasHtml(det) {
    var b = det.bancada || {}, item = det.item || {}, k = (item.contrato && item.contrato.componentes) || {}, p = b.promocao || {}, fr = k.frete || {};
    var dd = function (t, v) { return "<dt>" + esc(t) + "</dt><dd>" + v + "</dd>"; };
    return '<p class="rg-mudo">De onde vem cada informação, com os termos técnicos.</p><dl class="rg-evid">' +
      dd("Promoção que forma o preço", p.ativa ? esc(p.tipoRotulo) + (p.nome ? " · " + esc(p.nome) : "") + (p.id ? " · <code>" + esc(p.id) + "</code>" : "") + "<br>" + esc(p.texto || "") + "<br>Fonte: " + esc(p.fonte || "—") : "Nenhuma") +
      (p.iniciadas && p.iniciadas.length ? dd("Promoções iniciadas no anúncio", p.iniciadas.map(function (x) { return esc(x.tipoRotulo || x.tipo) + " a " + moeda(x.preco) + (x.formaPreco ? " — <b>forma o preço</b>" : " — não forma o preço") + (vazio(x.mlPct) ? " · participação do ML não informada" : " · ML " + pct(x.mlPct) + " / vendedor " + pct(x.vendPct)); }).join("<br>")) : "") +
      dd("Frete", (vazio(fr.valor) ? "desconhecido" : moeda(fr.valor)) + " · nível <code>" + esc(fr.nivel) + "</code> · confiança " + esc(fr.confianca) + (fr.modalidade && fr.modalidade.logistica ? " · logística <code>" + esc(fr.modalidade.logistica) + "</code>" : "") + (fr.fonte ? "<br>Fonte: <code>" + esc(fr.fonte) + "</code>" : "") + (fr.texto ? "<br>" + esc(fr.texto) : "")) +
      dd("Comissão", moeda(k.comissao && k.comissao.valor) + (k.comissao && !vazio(k.comissao.percentual) ? " (" + pct(k.comissao.percentual * 100, 0) + ")" : "") + " · <code>" + esc(k.comissao && k.comissao.fonte) + "</code>") +
      dd("Preço sugerido", b.sugerido && b.sugerido.preco ? moeda(b.sugerido.preco) + " · " + (b.sugerido.status === "RECOTADO" ? "recotado em " + data(b.sugerido.recotadoEm) : "preliminar") + (b.sugerido.texto ? "<br>" + esc(b.sugerido.texto) : "") : "não necessário") +
      ((b.pendencias || []).length ? dd("Observações", b.pendencias.map(function (x) { return esc(x.texto); }).join("<br>")) : "") +
      ((b.bloqueios || []).length ? dd("Bloqueios", b.bloqueios.map(function (x) { return "<code>" + esc(x.codigo) + "</code> " + esc(x.texto) + (x.resolveCom ? " — " + esc(x.resolveCom) : ""); }).join("<br>")) : "") +
      dd("Auditoria", "Situação <code>" + esc(b.status) + "</code> · " + esc(b.motivoStatus || "") + "<br>Avaliado em " + data(item.avaliadoEm) + " · preço visto " + moeda(item.fingerprint && item.fingerprint.precoVisto)) + "</dl>";
  }
  function painelPedidosHtml(p, aberto, detalhe) {
    if (!p) return '<div class="vf-loading-state"><span class="vf-spinner vf-spinner--sm"></span> Lendo pedidos na Central de Vendas…</div>';
    if (p.erro) return '<p class="rg-mudo">' + esc(p.erro) + "</p>";
    var c = p.comparacao || {}, r = c.realizado, j = c.projetado || {};
    return '<p class="rg-mudo">Pedidos reais da Central de Vendas · últimos ' + inteiro(p.periodo && p.periodo.dias) + " dias. Toque num pedido para ver o detalhe financeiro.</p>" +
      '<div class="rg-trio rg-trio--pq"><div><small>Margem projetada</small><strong class="rg-n">' + (vazio(j.margemPercent) ? "?" : pct(j.margemPercent)) + '</strong><span>preço de hoje</span></div><div><small>Margem realizada</small><strong class="rg-n">' + (r ? pct(r.margemPercent) : "—") + "</strong><span>" + (r ? inteiro(r.pedidos) + " pedidos confirmados" : "sem pedidos confirmados") + '</span></div><div><small>Preço médio vendido</small><strong class="rg-n">' + (r ? moeda(r.precoMedio) : "—") + "</strong><span>&nbsp;</span></div></div>" +
      "<p>" + esc(c.conclusao || "") + (c.nota ? " " + esc(c.nota) : "") + "</p>" + ((c.faltantes || []).length ? '<p class="rg-mudo">' + esc(c.faltantes.join(" ")) + "</p>" : "") +
      '<ul class="rg-peds">' + (p.pedidos || []).map(function (l) { return '<li data-rg-pedido="' + esc(l.rowId) + '"><span>' + esc(l.data || "—") + " · " + inteiro(l.unidades) + " un × " + moeda(l.precoUnitario) + '</span><span class="rg-n">' + (l.comprovado ? moeda(l.resultado) : "—") + "</span><span>" + (l.comprovado ? '<span class="rg-marca rg-marca--real">' + pct(l.margemRealizadaPercent) + "</span>" : '<span class="rg-marca rg-marca--blq" title="' + esc(l.motivoNaoComprovado) + '">não confirmado</span>') + "</span></li>" + (String(aberto) === String(l.rowId) ? '<li class="rg-ped-det">' + (detalhe ? detalhePedidoHtml(detalhe) : '<span class="vf-spinner vf-spinner--sm"></span>') + "</li>" : ""); }).join("") + "</ul>" +
      ((p.avisos || []).length ? '<p class="rg-mudo">' + esc(p.avisos.join(" ")) + "</p>" : "");
  }
  function detalhePedidoHtml(d) {
    if (d.erro) return esc(d.erro);
    var ped = d.pedido || {};
    return (ped.comprovado ? "" : '<p><strong>Resultado não confirmado:</strong> ' + esc(ped.motivoNaoComprovado || "") + "</p>") +
      (d.componentes || []).map(function (c) { return '<div class="rg-valor"><div>' + esc(c.rotulo) + (c.incluidoNoResultado === false ? ' <span class="rg-marca rg-marca--blq">informativo</span>' : "") + '</div><div class="rg-valor__v rg-n">' + (c.efeito === "debito" ? "− " : "+ ") + moeda(c.valor === null ? null : Math.abs(c.valor)) + "</div></div>"; }).join("") +
      (d.conferencia ? '<p class="rg-mudo">' + (d.conferencia.confere ? "A soma bate com o resultado do pedido (" + moeda(d.conferencia.resultadoPedido) + ")." : "A soma difere do resultado em " + moeda(d.conferencia.diferenca) + ".") + "</p>" : "") +
      '<p class="rg-mudo">' + esc(d.compensacoes && d.compensacoes.observacao || "") + " Descontos e bônus do ML: " + esc(d.compensacoes && d.compensacoes.descontosEBonusDoMl || "—") + "</p>";
  }

  // ── Cliente HTTP ───────────────────────────────────────────────────────
  function apiBase() { return String(root.VF_API_BASE || DEFAULT_API_BASE).replace(/\/$/, ""); }
  function token() { try { return root.localStorage ? root.localStorage.getItem("vf-token") : null; } catch (_) { return null; } }
  function chamar(caminho, opcoes) {
    var o = opcoes || {};
    var h = { Authorization: "Bearer " + token() };
    var init = { method: o.method || "GET", headers: h };
    if (o.body !== undefined) { h["Content-Type"] = "application/json"; init.body = JSON.stringify(o.body); }
    return root.fetch(apiBase() + caminho, init).then(function (r) { return r.json().catch(function () { return null; }).then(function (d) { return { ok: r.ok && d && d.ok !== false, status: r.status, data: d }; }); })
      .catch(function (e) { return { ok: false, status: 0, data: { motivo: e && e.message || "Falha de rede." } }; });
  }
  function lerPreferencia(k, padrao) { try { var v = root.localStorage && root.localStorage.getItem(k); return v === null || v === undefined ? padrao : v; } catch (_) { return padrao; } }
  function gravarPreferencia(k, v) { try { if (root.localStorage) root.localStorage.setItem(k, v); } catch (_) { /* sem storage */ } }

  // ── Estado ─────────────────────────────────────────────────────────────
  var estado = {
    cfg: { acoesHabilitadas: false, preview: false, recotacaoSobDemanda: false, simulacaoPreliminar: false },
    global: null, contaId: null, meta: 15, modo: "operacao", aba: "atencao", busca: "", ordem: "", pagina: 1, limite: 20, lista: null, contagens: {}, sel: {}, loteAberto: false,
    aberto: null, aba_b: "resumo", opcao: null, preco: null, sim: null, prelim: {}, confirmados: {}, promocoesVivas: null, promoSel: null, pedidos: null, pedidoAberto: null, pedidoDetalhe: null, salvo: null, acaoPendente: null,
    lote: { passo: 1, estrategia: "SAIR_CAMPANHA", teto: 30, fim90: true, resultado: null, incluir: {} },
  };
  var propostas = [];
  function $(id) { return root.document.getElementById(id); }
  function toast(msg, tom) { var el = root.document.createElement("div"); el.className = "vf-toast"; el.innerHTML = '<div class="vf-toast__content"><div class="vf-toast__title">' + esc(msg) + "</div></div>"; if (tom) el.dataset.tone = tom; $("rg-toasts").appendChild(el); setTimeout(function () { el.remove(); }, 6000); }
  function carregarPropostas() { try { propostas = JSON.parse(lerPreferencia("vf-resgate-propostas", "[]")) || []; } catch (_) { propostas = []; } contarPropostas(); }
  function guardarPropostas() { gravarPreferencia("vf-resgate-propostas", JSON.stringify(propostas.slice(-500))); contarPropostas(); }
  function contarPropostas() { var n = propostas.filter(function (p) { return p.conta === estado.contaId; }).length; var el = $("rg-n-prop"); if (el) el.textContent = n ? "(" + n + ")" : ""; }
  function atualizarHash() {
    var h = buildQuery({ conta: estado.contaId, filtro: estado.aba !== "atencao" ? estado.aba || "todos" : null, item: estado.aberto && estado.aberto.item ? estado.aberto.item.itemId : null, aba: estado.aberto && estado.aba_b !== "resumo" ? estado.aba_b : null }).replace(/^\?/, "");
    try { root.history.replaceState(null, "", h ? "#" + h : "#"); } catch (_) { /* sem history */ }
  }
  function urlItem(sufixo) { return "/resgate/contas/" + estado.contaId + "/itens/" + encodeURIComponent(estado.aberto.item.itemId) + (sufixo || ""); }
  function render() {
    var av = estado.modo === "avancado";
    $("rg-operacao").hidden = av; $("rg-avancado").hidden = !av;
    root.document.querySelectorAll("[data-rg-modo]").forEach(function (b) { var on = b.dataset.rgModo === estado.modo; b.classList.toggle("is-active", on); b.setAttribute("aria-pressed", String(on)); });
    if (av) return renderAvancado();
    renderLista(); renderBancada();
  }
  function renderModo() {
    var cfg = estado.cfg, el = $("rg-modo");
    var txt = cfg.preview ? "Preview local — somente leitura: a simulação é preliminar e nada é enviado ao Mercado Livre." : !cfg.acoesHabilitadas ? "Ações no Mercado Livre desligadas neste ambiente: você analisa, simula, recota e registra propostas." : "";
    el.hidden = !txt; el.textContent = txt;
  }

  // ── Lista operacional (layout A) ────────────────────────────────────────
  var ORDENS = [["", "Prioridade (prejuízo e exposição)"], ["margem", "Pior margem"], ["vendas", "Mais vendidos"]];
  function conta() { return ((estado.global && estado.global.contas) || []).filter(function (c) { return Number(c.clienteContaId) === estado.contaId; })[0] || {}; }
  function consultaLista(extra) { return buildQuery(Object.assign({ meta: estado.meta, busca: estado.busca }, extra || {})); }
  function itensVisiveis() {
    var l = estado.lista && estado.lista.itens ? estado.lista.itens.slice() : [];
    // Ordenação só da PÁGINA (o servidor já entrega por prioridade); dito na tela, como em Anúncios.
    if (estado.ordem === "margem") l.sort(function (a, z) { var x = a.bancada.margemPercent, y = z.bancada.margemPercent; return (vazio(x) ? 999 : x) - (vazio(y) ? 999 : y); });
    if (estado.ordem === "vendas") l.sort(function (a, z) { return (z.bancada.unidades30d || 0) - (a.bancada.unidades30d || 0); });
    return l;
  }
  function carregarLista() {
    var base = "/resgate/contas/" + estado.contaId + "/itens";
    estado.lista = null; renderLista();
    ABAS.forEach(function (a) { chamar(base + consultaLista({ filtro: a[0], limite: 1 })).then(function (r) { if (r.ok) { estado.contagens[a[0]] = r.data.total; pintarContagens(); } }); });
    return chamar(base + consultaLista({ filtro: estado.busca ? "" : estado.aba, pagina: estado.pagina, limite: estado.limite })).then(function (r) {
      estado.lista = r.ok ? r.data : { erro: (r.data && r.data.motivo) || "Erro ao listar." }; renderLista();
    });
  }
  function pintarContagens() { ABAS.forEach(function (a) { var el = root.document.querySelector('[data-rg-cont="' + a[0] + '"]'); if (el && estado.contagens[a[0]] !== undefined) el.textContent = inteiro(estado.contagens[a[0]]); }); }
  function revisadoLocal(id) { return propostas.some(function (p) { return p.conta === estado.contaId && p.id === id; }); }
  function linhaTabelaHtml(x) {
    var b = x.bancada || {}, s = situacao(b), p = b.promocao, rev = revisadoLocal(x.itemId) || (x.revisao && x.revisao.status && x.revisao.status !== "PENDENTE");
    var sug = b.sugerido || {}, sp = seloPreco(sug.status);
    return '<tr data-rg-item="' + esc(x.itemId) + '" tabindex="0" class="' + (estado.aberto && estado.aberto.item.itemId === x.itemId ? "is-sel " : "") + (rev ? "is-rev" : "") + '">' +
      '<td class="rg-col-sel"><input type="checkbox" data-rg-sel="' + esc(x.itemId) + '"' + (estado.sel[x.itemId] ? " checked" : "") + ' aria-label="Selecionar ' + esc(x.itemId) + '"></td>' +
      '<td><span class="rg-t1" title="' + esc(x.titulo) + '">' + (rev ? "✓ " : "") + esc(x.titulo || x.itemId) + '</span><span class="rg-mudo">' + esc(x.itemId) + (x.sku ? " · " + esc(x.sku) : "") + (b.unidades30d ? " · " + inteiro(b.unidades30d) + " vendas/mês" : "") + "</span></td>" +
      '<td class="rg-n">' + (p && b.precoCheio !== b.precoComprador ? '<s class="rg-mudo">' + moeda(b.precoCheio) + "</s><br>" : "") + "<b>" + moeda(b.precoComprador) + "</b></td>" +
      '<td class="rg-col-md">' + (p ? esc(p.tipoRotulo) + '<span class="rg-mudo">' + esc(p.financiamento === "VENDEDOR_100" ? "desconto todo do vendedor" : p.financiamento === "ML_COFINANCIA" ? "ML ajuda " + moeda(p.subsidio) + "/venda" : "ajuda do ML não comprovada") + "</span>" : '<span class="rg-mudo">sem promoção</span>') + "</td>" +
      '<td class="rg-n">' + (vazio(b.margemPercent) ? '<span class="rg-mudo">—</span>' : (b.limiteInferior ? "≥ " : "") + pct(b.margemPercent)) + "<br>" + situacaoHtml(s) + "</td>" +
      '<td class="rg-n rg-col-md">' + (sug.preco ? moeda(sug.preco) + '<br><span class="rg-marca rg-marca--' + sp.cls + '">' + sp.txt + "</span>" : '<span class="rg-mudo">—</span>') + "</td>" +
      '<td class="rg-col-acao"><span class="rg-prox">' + esc(curto(b.proximoPasso || s.curto, 90)) + "</span></td></tr>";
  }
  function renderLista() {
    var l = estado.lista, c = conta(), itens = itensVisiveis();
    var feitos = itens.filter(function (x) { return revisadoLocal(x.itemId) || (x.revisao && x.revisao.status && x.revisao.status !== "PENDENTE"); }).length;
    $("rg-chips").innerHTML = (estado.busca ? '<span class="rg-mudo">Busca: ' + inteiro(l && l.total) + " resultado(s)</span>" : ABAS.map(function (a) { return '<button class="vf-chip' + (estado.aba === a[0] ? " is-active" : "") + '" type="button" data-rg-aba="' + a[0] + '" aria-pressed="' + (estado.aba === a[0]) + '">' + a[1] + ' <span class="rg-cont" data-rg-cont="' + a[0] + '">' + (estado.contagens[a[0]] === undefined ? "" : inteiro(estado.contagens[a[0]])) + "</span></button>"; }).join("")) +
      '<span class="rg-prog">' + esc(c.contaNome || "") + " · revisados " + feitos + " de " + itens.length + ' nesta página<span class="rg-prog__b"><span style="width:' + (itens.length ? feitos / itens.length * 100 : 0) + '%"></span></span></span>';
    var tb = !l ? '<tr><td colspan="7"><div class="vf-loading-state"><span class="vf-spinner vf-spinner--sm"></span> Carregando…</div></td></tr>' : l.erro ? '<tr><td colspan="7" class="rg-mudo">' + esc(l.erro) + "</td></tr>"
      : itens.length ? itens.map(linhaTabelaHtml).join("") : '<tr><td colspan="7"><div class="vf-empty vf-empty--compact"><div class="vf-empty__title">Nenhum anúncio aqui.</div></div></td></tr>';
    $("rg-linhas").innerHTML = tb;
    $("rg-todos").checked = itens.length > 0 && itens.every(function (x) { return estado.sel[x.itemId]; });
    $("rg-pag").innerHTML = l && !l.erro ? "<span>" + (l.total ? inteiro((l.pagina - 1) * l.limite + 1) + "–" + inteiro(Math.min(l.total, l.pagina * l.limite)) + " de " + inteiro(l.total) : "0") + (estado.ordem ? " · ordenado só nesta página" : "") + '</span><span class="rg-teclas"><kbd>↑</kbd><kbd>↓</kbd> navegar · <kbd>/</kbd> buscar</span><span><button class="vf-btn vf-btn--ghost vf-btn--sm" type="button" data-rg-pag="-1"' + (l.pagina <= 1 ? " disabled" : "") + '>‹</button><button class="vf-btn vf-btn--ghost vf-btn--sm" type="button" data-rg-pag="1"' + (l.pagina * l.limite >= l.total ? " disabled" : "") + ">›</button></span>" : "";
    renderBarraLote();
  }

  // ── Bancada lateral (resumo · precificar · promoções · pedidos · detalhes) ──
  var ABAS_BANCADA = [["resumo", "Resumo"], ["precificar", "Precificar"], ["promocoes", "Promoções"], ["pedidos", "Pedidos"], ["detalhes", "Cálculo e evidências"]];
  function abrirItem(itemId, aba) {
    estado.aba_b = aba || "resumo"; estado.opcao = null; estado.preco = null; estado.sim = null; estado.prelim = {}; estado.confirmados = {};
    estado.promocoesVivas = null; estado.promoSel = null; estado.pedidos = null; estado.pedidoAberto = null; estado.pedidoDetalhe = null; estado.salvo = null; estado.loteAberto = false;
    estado.aberto = { carregando: true, item: { itemId: itemId } }; renderBancada(); renderLista();
    $("rg-bancada").classList.add("is-aberta");
    return chamar("/resgate/contas/" + estado.contaId + "/itens/" + encodeURIComponent(itemId) + buildQuery({ meta: estado.meta })).then(function (r) {
      if (!estado.aberto || estado.aberto.item.itemId !== itemId) return;
      if (!r.ok) { estado.aberto = { erro: (r.data && r.data.motivo) || "Erro ao abrir.", item: { itemId: itemId } }; renderBancada(); return; }
      estado.aberto = r.data; atualizarHash(); renderBancada();
      var tr = root.document.querySelector('tr[data-rg-item="' + itemId + '"]'); if (tr && tr.scrollIntoView) tr.scrollIntoView({ block: "nearest" });
      carregarPedidos();
      return preliminaresIniciais();
    });
  }
  function posicao() { var ids = itensVisiveis().map(function (x) { return x.itemId; }); return { ids: ids, k: estado.aberto ? ids.indexOf(estado.aberto.item.itemId) : -1 }; }
  function mover(d) {
    var p = posicao(), k = p.k + d;
    if (k >= 0 && k < p.ids.length) return abrirItem(p.ids[k], estado.aba_b === "pedidos" || estado.aba_b === "detalhes" ? estado.aba_b : "resumo");
    if (d > 0 && estado.lista && estado.lista.pagina * estado.lista.limite < estado.lista.total) { estado.pagina += 1; return carregarLista().then(function () { var ids = itensVisiveis(); if (ids[0]) abrirItem(ids[0].itemId); }); }
    toast(d > 0 ? "Fim da lista." : "Início da lista.", "info"); return null;
  }
  function fecharBancada() { estado.aberto = null; estado.loteAberto = false; $("rg-bancada").classList.remove("is-aberta"); renderBancada(); renderLista(); atualizarHash(); }
  function renderBancada() {
    var el = $("rg-bancada"), det = estado.aberto;
    if (estado.loteAberto) { el.innerHTML = loteHtml(); return; }
    if (!det) { el.innerHTML = '<div class="vf-empty"><div class="vf-empty__title">Escolha um anúncio</div><div class="vf-empty__description">Clique numa linha ou use ↑ ↓. A bancada abre aqui, sem sair da lista.</div></div>'; return; }
    if (det.carregando || det.erro) { el.innerHTML = cabBancada() + '<div class="rg-b-corpo">' + (det.erro ? '<p>' + esc(det.erro) + "</p>" : '<div class="vf-loading-state"><span class="vf-spinner vf-spinner--sm"></span> Abrindo…</div>') + "</div>"; return; }
    var aba = estado.aba_b, corpoAba;
    if (estado.salvo) corpoAba = salvoHtml();
    else if (aba === "resumo") corpoAba = resumoHtml();
    else if (aba === "precificar") corpoAba = resolverHtml() + '<div id="rg-proposta-slot">' + (podeConferir() ? propostaHtml() : "") + "</div>";
    else if (aba === "promocoes") corpoAba = promocoesAbaHtml();
    else if (aba === "pedidos") corpoAba = painelPedidosHtml(estado.pedidos, estado.pedidoAberto, estado.pedidoDetalhe);
    else corpoAba = '<h3 class="rg-h3">Composição da margem</h3>' + painelCalculoHtml(det.bancada) + '<h3 class="rg-h3">Evidências</h3>' + painelEvidenciasHtml(det);
    el.innerHTML = cabBancada() + '<div class="rg-b-corpo">' + corpoAba + "</div>";
    if (aba === "precificar" && !estado.salvo && opcaoAtual().tipo === "preco" && !estado.sim) agendarSimulacao(0);
  }
  function cabBancada() {
    var det = estado.aberto, p = posicao(), b = det.bancada, s = b ? situacao(b) : null;
    return '<div class="rg-b-cab"><div class="rg-b-nav"><button class="vf-btn vf-btn--ghost vf-btn--sm" type="button" data-rg-fechar aria-label="Fechar">✕</button><span class="rg-mudo">' + (p.k >= 0 ? p.k + 1 + " de " + p.ids.length : "") + '</span><span><button class="vf-btn vf-btn--ghost vf-btn--sm" type="button" data-rg-mover="-1" title="Anterior (↑)">‹</button><button class="vf-btn vf-btn--ghost vf-btn--sm" type="button" data-rg-mover="1" title="Próximo (↓)">›</button></span></div>' +
      '<div class="rg-b-tit"><div><span class="rg-mudo">' + esc(det.item.itemId) + (det.item.sku ? " · SKU " + esc(det.item.sku) : "") + "</span><h2>" + esc(curto(det.item.titulo || det.item.itemId, 90)) + "</h2></div>" + (s ? situacaoHtml(s) : "") + "</div>" +
      (b ? '<nav class="vf-tabs rg-b-abas" role="tablist">' + ABAS_BANCADA.map(function (a) { return '<button class="vf-tab' + (estado.aba_b === a[0] ? " is-active" : "") + '" role="tab" type="button" aria-selected="' + (estado.aba_b === a[0]) + '" data-rg-aba-b="' + a[0] + '">' + a[1] + (a[0] === "pedidos" && estado.pedidos && estado.pedidos.pedidos ? " (" + estado.pedidos.pedidos.length + ")" : "") + "</button>"; }).join("") + "</nav>" : "") + "</div>";
  }
  function resumoHtml() {
    var det = estado.aberto, b = det.bancada, x = entender(det, estado.prelim, estado.meta), o = opcaoAtual();
    var ped = estado.pedidos && estado.pedidos.comparacao && estado.pedidos.comparacao.realizado;
    return identificarHtml(det, estado.meta) +
      '<ul class="rg-explica">' + x.frases.map(function (f, k) { return '<li class="' + (f.c ? "is-" + f.c : "") + '"><i>' + (k + 1) + "</i><span>" + esc(f.t) + "</span></li>"; }).join("") + "</ul>" +
      (b.resultado && b.resultado.calculavel ? paraOndeHtml(b) : "") +
      (ped ? '<div class="rg-realizado">Pedidos reais (60 dias): margem real de <b>' + pct(ped.margemPercent) + "</b> em " + inteiro(ped.pedidos) + " vendas confirmadas, a " + moeda(ped.precoMedio) + ' em média. <button class="rg-link" type="button" data-rg-aba-b="pedidos">Ver pedidos</button></div>' : "") +
      '<div class="rg-sugerida"><div><small class="rg-mudo">Próxima ação sugerida</small><b>' + esc(o.titulo) + '</b><span class="rg-mudo">' + esc(o.desc) + '</span></div><div class="rg-sugerida__btns"><button class="vf-btn vf-btn--primary" type="button" data-rg-ir-opcao="' + esc(o.id) + '">' + (o.tipo === "manter" ? "Registrar e ir ao próximo" : o.tipo === "comparar" ? "Comparar promoções" : o.tipo === "tarefa" ? "Ver como resolver" : "Simular preço") + '</button><button class="vf-btn vf-btn--ghost" type="button" data-rg-mover="1">Pular</button></div></div>';
  }
  function promocoesAbaHtml() {
    var det = estado.aberto, podeVivas = !estado.cfg.preview && Boolean(det.contexto && det.contexto.clienteSlug);
    var linhas = linhasPromocao(det, estado.promocoesVivas, estado.prelim);
    if (!estado.promoSel) { var at = linhas.filter(function (x) { return x.grupo === "ativa"; })[0] || linhas[0]; estado.promoSel = at ? at.chave : null; }
    var sel = linhaSelecionada();
    return '<h3 class="rg-h3">Promoção que forma o preço</h3>' + (promo(det.bancada) ? '<p>' + esc(promo(det.bancada).texto || "") + '</p><p class="rg-mudo">Fonte: ' + esc(origem(promo(det.bancada).fonte)) + "</p>" : '<p class="rg-mudo">Sem promoção: o comprador paga o preço cheio.</p>') +
      '<h3 class="rg-h3">Comparar</h3>' + compararHtml(linhas, estado.promoSel, Boolean(estado.promocoesVivas && estado.promocoesVivas.length), podeVivas) +
      (sel && sel.grupo !== "ativa" ? '<div class="rg-ad-promo">' + antesDepoisHtml(det, sel.margem === null ? { preco: sel.preco, calculavel: false, bloqueios: [{ texto: "Margem nesta promoção não calculável." }] } : { preco: sel.preco, tipo: "PRELIMINAR", calculavel: true, margemPercent: sel.margem, lucro: sel.lucro, comissao: null, frete: null, avisos: [sel.minimo ? "O Mercado Livre não informa quanto paga nesta promoção: margem mínima." : "Estimativa: comissão e frete mantidos como hoje."] }, estado.meta) + (sel.grupo === "ml" ? '<p class="rg-mudo">Esta promoção só pode ser ativada no painel do Mercado Livre.</p>' : '<div class="rg-rodape"><span></span><button class="vf-btn vf-btn--primary" type="button" data-rg-propor-promo>' + esc(sel.grupo === "participa" ? "Propor: voltar para " + moeda(sel.preco) : "Propor: participar por " + moeda(sel.preco)) + "</button></div>") + "</div>" : "");
  }
  function propostaHtml() {
    var det = estado.aberto, b = det.bancada, x = proposta(), r = opcaoAtual().tipo === "preco" ? estado.sim : null;
    var linhas = [], add = function (rot, val, s, txt) { linhas.push('<div class="rg-valor"><div>' + esc(rot) + ' <span class="rg-marca rg-marca--' + s.cls + '">' + esc(s.txt) + '</span></div><div class="rg-valor__v rg-n">' + val + '</div><div class="rg-valor__o">' + esc(txt) + "</div></div>"); };
    if (r && r.calculavel) {
      var rec = r.tipo === "CONFIRMADO";
      add("Comissão do Mercado Livre", moeda(r.comissao && r.comissao.valor), rec ? { cls: "rec", txt: "cotada neste preço" } : { cls: "pre", txt: "do preço atual" }, rec ? "tabela de comissões do Mercado Livre, para este preço" : "percentual de hoje, a confirmar para o novo preço");
      add("Frete", moeda(r.frete && r.frete.valor), rec ? { cls: "rec", txt: "cotado neste preço" } : { cls: "pre", txt: "do preço atual" }, rec ? origem(r.frete && r.frete.fonte) : "frete de hoje (" + seloFrete(linhaCascata(b, "frete") && Object.assign({}, det.item.contrato.componentes.frete)).txt + "), a confirmar");
      add("Custo do produto", moeda(cv(b, "custo")), selo(linhaCascata(b, "custo")), origem((linhaCascata(b, "custo") || {}).fonte));
      add("Imposto", "proporcional ao preço", selo(linhaCascata(b, "imposto")), ((linhaCascata(b, "imposto") || {}).rotulo || "") + " · " + origem((linhaCascata(b, "imposto") || {}).fonte));
      if (cv(b, "taxaFixa")) add("Taxa fixa", moeda(cv(b, "taxaFixa")), selo(linhaCascata(b, "taxaFixa")), origem(linhaCascata(b, "taxaFixa").fonte));
      if (cofinanciada(b)) add("Ajuda do Mercado Livre", "não passa para o preço novo", { cls: "blq", txt: "promoção atual" }, "o preço novo não herda a promoção atual");
    }
    var podeAplicar = podeAgir(det.contexto, estado.cfg) && x.situacao === "CONFIRMADO";
    var acoesReais = x.acoes.length ? '<div class="rg-acoes-reais"><h3 class="rg-h3">Aplicar no Mercado Livre</h3><p class="rg-mudo">' + esc(!podeAgir(det.contexto, estado.cfg) ? motivoSemAcoes(det.contexto, estado.cfg) : x.situacao !== "CONFIRMADO" ? "Só preços recotados no Mercado Livre podem ser aplicados." : "Cada passo relê o preço e pede confirmação.") + "</p>" +
      x.acoes.map(function (a, k) { return '<button class="vf-btn vf-btn--secondary vf-btn--sm" type="button" data-rg-acao-real="' + k + '"' + (podeAplicar ? "" : " disabled") + ">" + esc(a.rotulo) + "</button>"; }).join(" ") + "</div>" : "";
    return '<div class="rg-proposta-box"><small class="rg-mudo">Sua proposta</small><p class="rg-proposta">' + esc(x.texto || "") + "</p>" +
      (linhas.length ? '<details class="rg-det"><summary>Valores usados e origem</summary><div class="rg-valores">' + linhas.join("") + "</div></details>" : "") +
      '<div class="rg-rodape"><button class="vf-btn vf-btn--ghost" type="button" data-rg-aba-b="resumo">← Resumo</button><button class="vf-btn vf-btn--primary" type="button" data-rg-pre-registrar>' + esc(x.tipo === "manter" ? "Registrar e ir ao próximo" : x.tipo === "tarefa" ? "Registrar tarefa e ir ao próximo" : "Registrar proposta" + (x.preco ? " de " + moeda(x.preco) : "") + " e ir ao próximo") + "</button></div>" + acoesReais + "</div>";
  }
  function salvoHtml() {
    var s = estado.salvo;
    var msg = s.servidor ? "Registrada na revisão do anúncio." : s.motivo === "preview" ? "Guardada neste navegador (o preview não grava no servidor)." : "Guardada neste navegador. O servidor não registrou: " + s.motivo;
    return '<div class="rg-ok"><div class="rg-ok__ic">✓</div><h3>Proposta registrada</h3><p class="rg-mudo">' + esc(msg) + ' Nada foi enviado ao Mercado Livre.</p><div class="rg-ok__acoes"><button class="vf-btn vf-btn--primary" type="button" data-rg-mover="1">Próximo anúncio →</button><button class="vf-btn vf-btn--ghost" type="button" data-rg-ver-propostas>Ver propostas</button></div></div>';
  }
  /** Preliminares de apoio (sem ML): preço cheio, campanha por baixo, sugerido e promoções iniciadas — para explicar e comparar. */
  function preliminaresIniciais() {
    var b = estado.aberto.bancada || {}, ps = [];
    var add = function (v) { if (!vazio(v) && ps.indexOf(Number(v)) < 0) ps.push(Number(v)); };
    if (b.resultado && b.resultado.calculavel) { add(b.precos.cheio); if (b.precos.campanhaVendedor) add(b.precos.campanhaVendedor.preco); ((promo(b) && promo(b).iniciadas) || []).forEach(function (x) { if (!x.formaPreco) add(x.preco); }); }
    return simularPreliminar(ps.slice(0, 8)).then(function () { if (estado.aberto && estado.aberto.bancada) renderBancada(); });
  }
  function simularPreliminar(precos) {
    if (!precos.length || !estado.cfg.simulacaoPreliminar || !estado.aberto) return Promise.resolve(null);
    return chamar(urlItem("/simular"), { method: "POST", body: { precos: precos, meta: estado.meta, preliminar: true } }).then(function (r) {
      if (r.ok) (r.data.simulacoes || []).forEach(function (s) { estado.prelim[String(s.preco)] = s; });
      return r;
    });
  }
  function opcaoAtual() { var det = estado.aberto; if (!det || !det.bancada) return null; var a = opcoes(det, estado.meta); if (!estado.opcao) { var rec = a.filter(function (x) { return x.rec; })[0] || a[0]; estado.opcao = rec.id; } return a.filter(function (x) { return x.id === estado.opcao; })[0] || a[0]; }
  function podeConferir() { var o = opcaoAtual(); if (!o) return false; if (o.tipo === "preco") return Boolean(estado.sim && estado.sim.calculavel); if (o.tipo === "comparar") { var l = linhaSelecionada(); return Boolean(l && !l.forma && l.grupo !== "ativa" && l.grupo !== "ml"); } return true; }
  function resolverHtml() {
    var det = estado.aberto, b = det.bancada, a = opcoes(det, estado.meta), o = opcaoAtual();
    var html = '<section class="rg-bloco"><h3 class="rg-h3">O que você quer fazer?</h3><p class="rg-mudo">Mostramos só as opções possíveis para este anúncio.</p><div class="rg-opcoes">' +
      a.map(function (x) { return '<button type="button" class="rg-opcao' + (x.id === o.id ? " is-ativo" : "") + '" data-rg-opcao="' + x.id + '"><span class="rg-radio"></span><div><strong>' + esc(x.titulo) + "</strong>" + (x.rec ? "<em>sugerido</em>" : "") + "<span>" + esc(x.desc) + "</span></div></button>"; }).join("") + "</div>";
    if (o.tipo === "preco") {
      var rc = recotado(b);
      if (estado.preco === null) { var porBaixo = o.id === "sair" && cofinanciada(b) && b.precos.campanhaVendedor; estado.preco = (porBaixo && o.base) || (rc && rc.preco) || (b.sugerido && b.sugerido.preco) || o.base || b.precos.comprador; agendarSimulacao(0); }
      html += '<div class="rg-sim"><div class="rg-sim__preco"><label for="rg-sim-preco">' + (o.id === "promo" ? "Novo preço promocional" : o.id === "sair" && b.precos.campanhaVendedor && cofinanciada(b) ? "Preço promocional da sua campanha" : o.id === "sair" ? "Preço cheio" : "Novo preço") + '</label><button class="rg-passo-btn" type="button" data-rg-ajuste="-1" aria-label="Diminuir R$ 1">−</button><span class="rg-campo-preco"><span>R$</span><input id="rg-sim-preco" inputmode="decimal" value="' + esc(String(Number(estado.preco).toFixed(2)).replace(".", ",")) + '"></span><button class="rg-passo-btn" type="button" data-rg-ajuste="1" aria-label="Aumentar R$ 1">+</button></div>' +
        '<div class="rg-atalhos">' + (rc ? '<button class="rg-atalho is-ok" type="button" data-rg-preco="' + rc.preco + '">✓ Para ' + pct(estado.meta, 0) + ", preço recotado no ML: " + moeda(rc.preco) + "</button>" : b.sugerido && b.sugerido.preco ? '<button class="rg-atalho" type="button" data-rg-preco="' + b.sugerido.preco + '">Para ' + pct(estado.meta, 0) + " (preliminar): " + moeda(b.sugerido.preco) + "</button>" : "") +
        (o.base && o.base !== b.precos.comprador ? '<button class="rg-atalho" type="button" data-rg-preco="' + o.base + '">' + (b.precos.campanhaVendedor && o.base === b.precos.campanhaVendedor.preco ? "Preço da sua campanha: " : "Preço cheio: ") + moeda(o.base) + "</button>" : "") +
        '<button class="rg-atalho" type="button" data-rg-preco="' + b.precos.comprador + '">Preço de hoje: ' + moeda(b.precos.comprador) + "</button></div>" +
        '<div id="rg-sim-saida">' + antesDepoisHtml(det, estado.sim, estado.meta) + '</div><div id="rg-confirmar-slot">' + confirmarMlHtml() + "</div></div>";
    } else if (o.tipo === "comparar") {
      html += '<div class="rg-tarefa"><p>A comparação fica na aba <b>Promoções</b>, com as promoções agrupadas como na tela de Anúncios.</p><button class="vf-btn vf-btn--secondary vf-btn--sm" type="button" data-rg-aba-b="promocoes">Abrir Promoções</button></div>';
    } else if (o.tipo === "tarefa") {
      html += '<div class="rg-tarefa"><h3>' + (o.id === "completar" ? "Como resolver" : "O que acontece") + "</h3><ol>" + (o.passos || []).map(function (x) { return "<li>" + esc(x) + "</li>"; }).join("") + "</ol>" + (o.recotar ? confirmarMlHtml(true) : "") + '<p class="rg-mudo">Enquanto isso, nenhum preço é sugerido como definitivo para este anúncio.</p></div>';
    } else html += '<div class="rg-tarefa"><h3>Nada será alterado</h3><p>O anúncio continua como está. Você pode registrar a decisão para não revisar de novo agora.</p></div>';
    return html + "</section>";
  }
  function linhaSelecionada() { var det = estado.aberto; if (!det) return null; return linhasPromocao(det, estado.promocoesVivas, estado.prelim).filter(function (x) { return x.chave === estado.promoSel; })[0] || null; }
  function confirmarMlHtml(soLeitura) {
    var pode = estado.cfg.recotacaoSobDemanda && !estado.cfg.preview;
    if (estado.sim && estado.sim.tipo === "CONFIRMADO" && !soLeitura) return "";
    return '<div class="rg-confirmar"><button class="vf-btn vf-btn--secondary" type="button" data-rg-recotar' + (pode ? "" : ' disabled title="Indisponível neste ambiente"') + ">" + (soLeitura ? "Ler a promoção no Mercado Livre agora" : "Confirmar no Mercado Livre") + '</button><span class="rg-mudo">' + (pode ? "Consulta comissão, frete e promoções no Mercado Livre (só leitura, cerca de 20 consultas)." : estado.cfg.preview ? "No preview local não há leitura do Mercado Livre: o resultado fica preliminar." : "Leitura do Mercado Livre indisponível neste ambiente.") + "</span></div>";
  }
  function dialogoRegistrar() {
    var det = estado.aberto, b = det.bancada, x = proposta(), lin = [["Anúncio", det.item.itemId]];
    if (x.preco) { lin.push(["Comprador paga", moeda(b.precos.comprador) + " → " + moeda(x.preco)]); lin.push(["Margem", pct(margem(b)) + " → " + pct(x.margem)]); lin.push(["Lucro por venda", moeda(lucro(b)) + " → " + moeda(x.lucro)]); lin.push(["Situação do cálculo", x.situacao === "CONFIRMADO" ? "confirmado no Mercado Livre" : "preliminar"]); }
    $("rg-dialogo").innerHTML = '<div class="rg-dialogo__caixa" role="dialog" aria-modal="true" aria-labelledby="rg-dlg-t"><h3 id="rg-dlg-t">Registrar esta proposta?</h3><p class="rg-mudo">' + esc(x.texto) + '</p><div class="rg-valores">' + lin.map(function (l) { return '<div class="rg-valor"><div>' + esc(l[0]) + '</div><div class="rg-valor__v rg-n">' + esc(l[1]) + "</div></div>"; }).join("") + '</div><p class="rg-mudo">Nada é enviado ao Mercado Livre. A proposta fica registrada na revisão do anúncio' + (estado.cfg.preview ? " (no preview, só neste navegador)" : "") + '.</p><div class="rg-dialogo__acoes"><button class="vf-btn vf-btn--ghost" type="button" data-rg-dlg-fechar>Cancelar</button><button class="vf-btn vf-btn--primary" type="button" data-rg-registrar>Registrar</button></div></div>';
    $("rg-dialogo").hidden = false;
  }
  function registrar() {
    var det = estado.aberto, x = proposta(); $("rg-dialogo").hidden = true;
    var nota = ("Proposta: " + x.texto + (x.preco ? " · " + (x.situacao === "CONFIRMADO" ? "recotado" : "preliminar") + " · margem " + pct(x.margem) : "")).slice(0, 500);
    var reg = { conta: estado.contaId, id: det.item.itemId, titulo: curto(det.item.titulo, 70), texto: x.texto, preco: x.preco, margem: x.margem, situacao: x.situacao || x.tipo, em: new Date().toISOString(), servidor: false };
    return chamar(urlItem("/revisao"), { method: "POST", body: { status: x.status, nota: nota, precoVisto: det.item.fingerprint && det.item.fingerprint.precoVisto } }).then(function (r) {
      reg.servidor = r.ok; propostas = propostas.filter(function (p) { return !(p.conta === reg.conta && p.id === reg.id); }); propostas.push(reg); guardarPropostas();
      estado.salvo = { servidor: r.ok, motivo: r.ok ? null : r.status === 409 ? (r.data && r.data.motivo) : r.status === 501 ? "preview" : (r.data && r.data.motivo) || "erro" };
      renderLista();
      if (r.ok || r.status === 501) { toast(r.ok ? "Proposta registrada na revisão. Indo ao próximo anúncio." : "Proposta guardada neste navegador (preview). Indo ao próximo anúncio.", "success"); return mover(1) || renderBancada(); }
      renderBancada();
    });
  }
  function abrirPedido(rowId) {
    if (String(estado.pedidoAberto) === String(rowId)) { estado.pedidoAberto = null; return renderBancada(); }
    estado.pedidoAberto = rowId; estado.pedidoDetalhe = null; renderBancada();
    return chamar(urlItem("/pedidos/" + encodeURIComponent(rowId)) + buildQuery({ dias: 60, meta: estado.meta })).then(function (r) {
      estado.pedidoDetalhe = r.ok ? r.data : { erro: (r.data && r.data.motivo) || "Detalhe indisponível." }; if (String(estado.pedidoAberto) === String(rowId)) renderBancada();
    });
  }
  function fecharPainel() { $("rg-painel").hidden = true; $("rg-painel-fundo").hidden = true; }
  function painelPropostas() {
    var l = propostas.filter(function (p) { return p.conta === estado.contaId; });
    var p = $("rg-painel"); p.dataset.aba = "propostas";
    p.innerHTML = '<button class="rg-fechar" type="button" data-rg-painel-fechar aria-label="Fechar">×</button><div class="rg-painel__cab"><h2>Propostas desta conta (' + l.length + ')</h2><p class="rg-mudo">Nada foi enviado ao Mercado Livre.</p></div><div class="rg-painel__corpo">' +
      (l.length ? '<div class="rg-props">' + l.map(function (x) { return '<div class="rg-prop"><div class="rg-prop__t"><b>' + esc(x.titulo) + '</b><span class="rg-mudo">' + esc(x.id) + " · " + esc(x.texto) + '</span></div><div class="rg-prop__p rg-n">' + (x.preco ? moeda(x.preco) : "—") + '</div><div class="rg-prop__m">' + (vazio(x.margem) ? "" : pct(x.margem) + " · ") + esc(String(x.situacao || "").toLowerCase()) + (x.servidor ? " · registrada" : " · só neste navegador") + "</div></div>"; }).join("") + '</div><div class="rg-ok__acoes"><button class="vf-btn vf-btn--secondary" type="button" data-rg-csv>Baixar planilha</button><button class="vf-btn vf-btn--ghost" type="button" data-rg-limpar-propostas>Limpar a lista deste navegador</button></div>' : '<p class="rg-mudo">Nenhuma proposta ainda.</p>') + "</div>";
    p.hidden = false; $("rg-painel-fundo").hidden = false;
  }
  var timerSim = null;
  function agendarSimulacao(ms) {
    clearTimeout(timerSim);
    timerSim = setTimeout(function () {
      var det = estado.aberto, p = Number(estado.preco); if (!det || !(p > 0)) return;
      var rc = recotado(det.bancada), conf = estado.confirmados[String(p)];
      if (conf) { estado.sim = conf; return pintarSim(); }
      if (rc && Math.abs(rc.preco - p) < 0.005) { estado.sim = normalizarSim(rc, "CONFIRMADO"); return pintarSim(); }
      var cache = estado.prelim[String(p)];
      if (cache) { estado.sim = normalizarSim(cache, "PRELIMINAR"); return pintarSim(); }
      if (!estado.cfg.simulacaoPreliminar) { estado.sim = null; return pintarSim(); }
      simularPreliminar([p]).then(function () { if (estado.aberto === det && Number(estado.preco) === p) { estado.sim = normalizarSim(estado.prelim[String(p)], "PRELIMINAR"); pintarSim(); } });
    }, ms === undefined ? 300 : ms);
  }
  function pintarSim() {
    var el = $("rg-sim-saida"); if (el) el.innerHTML = antesDepoisHtml(estado.aberto, estado.sim, estado.meta);
    var c = $("rg-confirmar-slot"); if (c) c.innerHTML = confirmarMlHtml();
    var pr = root.document.querySelector(".rg-proposta-box"), alvo = $("rg-proposta-slot");
    if (alvo) alvo.innerHTML = podeConferir() ? propostaHtml() : ""; void pr;
  }
  /** Recotação REAL (somente GET no ML): confirma o preço escolhido, ou relê a promoção. */
  function recotar() {
    var det = estado.aberto; if (!det || !estado.cfg.recotacaoSobDemanda || estado.cfg.preview) return Promise.resolve(null);
    var o = opcaoAtual(), p = Number(estado.preco);
    toast("Consultando o Mercado Livre (somente leitura)…", "info");
    var body = o.tipo === "preco" && p > 0 ? { precos: [p], meta: estado.meta, recotar: false } : { meta: estado.meta };
    return chamar(urlItem("/simular"), { method: "POST", body: body }).then(function (r) {
      if (!r.ok) { toast((r.data && r.data.motivo) || "Não foi possível consultar o Mercado Livre.", "danger"); return r; }
      if (r.data.precoMudouDesdeAuditoria) toast("O preço mudou desde a auditoria: os números foram relidos agora.", "warning");
      if (r.data.bancada) estado.aberto = Object.assign({}, estado.aberto, { bancada: r.data.bancada, aoVivo: r.data.observadoEm });
      var s = (r.data.simulacoes || [])[0];
      if (s) { var n = normalizarSim(Object.assign({}, s, { observadoEm: r.data.observadoEm }), "CONFIRMADO"); n.calculavel = Boolean(s.resultado && s.resultado.calculavel); estado.confirmados[String(s.preco)] = n; estado.sim = n; }
      renderBancada(); return r;
    });
  }
  function lerPromocoesVivas() {
    var det = estado.aberto, ctx = det && det.contexto; if (!ctx || !ctx.clienteSlug || estado.cfg.preview) return null;
    return chamar("/anuncios-meli/" + encodeURIComponent(det.item.itemId) + "/promocoes" + buildQuery({ clienteSlug: ctx.clienteSlug, clienteContaId: ctx.clienteContaId })).then(function (r) {
      if (!r.ok) { toast((r.data && r.data.motivo) || "Não foi possível ler as promoções.", "danger"); return; }
      estado.promocoesVivas = r.data.promocoes || []; estado.promoSel = null; renderBancada();
    });
  }

  /** A proposta em palavras e a ação real correspondente (para quando as ações forem liberadas). */
  function proposta() {
    var det = estado.aberto, b = det.bancada, o = opcaoAtual(), p = promo(b), r = o.tipo === "preco" ? estado.sim : null, sel = o.tipo === "comparar" ? linhaSelecionada() : null;
    var x = { opcao: o.id, tipo: o.tipo, preco: r ? r.preco : sel ? sel.preco : null, margem: r ? r.margemPercent : sel ? sel.margem : null, lucro: r ? r.lucro : sel ? sel.lucro : null, situacao: r ? r.tipo : sel ? "PRELIMINAR" : null, acoes: [] };
    if (o.tipo === "manter") { x.texto = cofinanciada(b) ? "Continuar na promoção " + nomePromo(p) + "." : "Manter o anúncio como está."; x.status = "REJEITADO"; }
    else if (o.tipo === "tarefa") { x.texto = o.id === "completar" ? "Completar a informação: " + (b.bloqueios || []).map(function (y) { return textoBloqueio(y.codigo).curto.toLowerCase(); }).join(", ") + "." : "Confirmar no Mercado Livre quanto ele paga da promoção."; x.status = "PENDENTE"; }
    else if (o.tipo === "comparar" && sel) {
      if (sel.grupo === "participa") { x.texto = "Sair de " + nomePromo(p) + " e voltar para " + sel.nome + " (" + moeda(sel.preco) + ")."; if (p) x.acoes.push({ tipo: "SAIR_DA_PROMOCAO", rotulo: "Sair da promoção " + nomePromo(p), promocaoId: p.id, promocaoTipo: p.tipo, suportada: Boolean(p.modoEscrita && p.id), endpoint: "POST /anuncios-meli/:itemId/promocoes/:promotionId/sair", resultadoEsperado: { precoComprador: sel.preco, recotado: false } }); }
      else { x.texto = "Participar de " + sel.nome + " por " + moeda(sel.preco) + "."; if (sel.modoEscrita === "ACEITE") x.acoes.push({ tipo: "PARTICIPAR", rotulo: "Participar: " + sel.nome, promocaoId: sel.id, promocaoTipo: sel.tipo, suportada: true, endpoint: "POST /anuncios-meli/:itemId/promocoes/:promotionId/participar", resultadoEsperado: { precoComprador: sel.preco, recotado: false } }); }
      x.status = "PENDENTE";
    } else if (r) {
      var conf = r.tipo === "CONFIRMADO", mr = conf ? r.margemPercent : undefined;
      if (o.id === "sair") {
        var oc = b.precos.campanhaVendedor && cofinanciada(b) ? b.precos.campanhaVendedor : null;
        x.texto = "Sair da " + (doVendedor(b) ? "campanha " : "promoção ") + nomePromo(p) + (oc ? (Math.abs(r.preco - oc.preco) < 0.005 ? "; o comprador passa a pagar " + moeda(r.preco) + " da sua campanha " + nomePromo(oc) + "." : " e ajustar sua campanha " + nomePromo(oc) + " para " + moeda(r.preco) + ".") : " e alterar o preço cheio para " + moeda(r.preco) + ".");
        x.acoes.push({ tipo: "SAIR_DA_PROMOCAO", rotulo: "1. Sair da " + (doVendedor(b) ? "campanha " : "promoção ") + nomePromo(p), promocaoId: p.id, promocaoTipo: p.tipo, suportada: Boolean(p.modoEscrita && p.id), endpoint: "POST /anuncios-meli/:itemId/promocoes/:promotionId/sair", resultadoEsperado: { precoComprador: oc ? oc.preco : b.precos.cheio, recotado: false } });
        if (!oc && Math.abs(r.preco - b.precos.cheio) >= 0.005) x.acoes.push({ tipo: "ALTERAR_PRECO", rotulo: "2. Alterar o preço cheio para " + moeda(r.preco), precoAlvo: r.preco, margemRecotadaPercent: mr, requerAntes: "SAIR_DA_PROMOCAO", suportada: true, endpoint: "PATCH /anuncios-meli/:itemId/preco" });
      } else if (o.id === "promo") { x.texto = "Alterar o preço promocional de " + moeda(b.precos.comprador) + " para " + moeda(r.preco) + "."; x.acoes.push({ tipo: "ALTERAR_PRECO_PROMOCIONAL", rotulo: "Alterar o preço promocional para " + moeda(r.preco), precoAlvo: r.preco, margemRecotadaPercent: mr, promocaoId: p.id, promocaoTipo: p.tipo, suportada: Boolean(p.id), endpoint: "POST /anuncios-meli/:itemId/promocoes/:promotionId/aplicar" }); }
      else { x.texto = "Alterar o preço " + (o.id === "pior" ? "(pior caso, sem ajuda do Mercado Livre) " : "") + "de " + moeda(b.precos.comprador) + " para " + moeda(r.preco) + "."; if (!p) x.acoes.push({ tipo: "ALTERAR_PRECO", rotulo: "Alterar o preço para " + moeda(r.preco), precoAlvo: r.preco, margemRecotadaPercent: mr, suportada: true, endpoint: "PATCH /anuncios-meli/:itemId/preco" }); }
      x.status = conf ? "APROVADO" : "PENDENTE";
    }
    return x;
  }
  function carregarPedidos() {
    if (!estado.aberto) return null;
    var id = estado.aberto.item.itemId;
    return chamar(urlItem("/pedidos") + buildQuery({ dias: 60, meta: estado.meta })).then(function (r) {
      if (!estado.aberto || estado.aberto.item.itemId !== id) return;
      estado.pedidos = r.ok ? r.data : { erro: ({ 409: "Esta conta não tem cliente vinculado: pedidos indisponíveis.", 501: "Pedidos indisponíveis neste preview para este anúncio.", 503: "A Central de Vendas ainda não está disponível neste ambiente." })[r.status] || (r.data && r.data.motivo) || "Não foi possível ler os pedidos." };
      if (estado.aba_b === "pedidos" || estado.aba_b === "resumo") renderBancada();
    });
  }
  function baixarCsv(nome, linhas) {
    var csv = linhas.map(function (l) { return l.map(function (c) { var s = String(c === null || c === undefined ? "" : c); return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(";"); }).join("\n");
    var a = root.document.createElement("a"); a.href = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" })); a.download = nome; a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }

  // ── Vários anúncios: seleção múltipla → propostas em lote (nada é aplicado) ──
  function selecionados() { return Object.keys(estado.sel).filter(function (k) { return estado.sel[k]; }); }
  function renderBarraLote() {
    var n = selecionados().length, el = $("rg-lote-barra"); if (!el) return;
    el.hidden = !n || estado.loteAberto;
    $("rg-lote-txt").textContent = n + " selecionado(s)";
  }
  function abrirLote() { estado.loteAberto = true; estado.lote.passo = 1; estado.lote.resultado = null; estado.lote.incluir = {}; $("rg-bancada").classList.add("is-aberta"); renderBancada(); renderBarraLote(); }
  function selecionarFiltroInteiro() {
    var base = "/resgate/contas/" + estado.contaId + "/itens", pg = 1, total = 0;
    function prox() {
      return chamar(base + consultaLista({ filtro: estado.busca ? "" : estado.aba, pagina: pg, limite: 100 })).then(function (r) {
        if (!r.ok) return; total = r.data.total; (r.data.itens || []).forEach(function (x) { estado.sel[x.itemId] = true; });
        if (pg * 100 < total && pg < 5) { pg += 1; return prox(); }
      });
    }
    return prox().then(function () { renderLista(); if (total > 500) toast("Selecionados os 500 primeiros do filtro.", "info"); });
  }
  function loteHtml() {
    var L = estado.lote, n = selecionados().length, html = '<div class="rg-b-cab"><div class="rg-b-nav"><button class="vf-btn vf-btn--ghost vf-btn--sm" type="button" data-rg-fechar aria-label="Fechar">✕</button><span class="rg-mudo">Propostas em lote · ' + n + ' anúncio(s)</span><span></span></div><div class="rg-b-tit"><div><h2>Preparar preços de vários anúncios</h2><span class="rg-mudo">Nada é aplicado: as propostas ficam para revisão.</span></div></div>' +
      '<nav class="rg-wiz">' + [[1, "Estratégia"], [2, "Exceções"], [3, "Revisar"]].map(function (w) { return '<span class="' + (L.passo === w[0] ? "is-ativo" : L.passo > w[0] ? "is-feito" : "") + '">' + w[0] + ". " + w[1] + "</span>"; }).join("") + '</nav></div><div class="rg-b-corpo">';
    if (L.passo === 1) {
      html += '<div class="rg-opcoes">' + ESTRATEGIAS.map(function (x) { return '<button type="button" class="rg-opcao' + (L.estrategia === x[0] ? " is-ativo" : "") + '" data-rg-estrategia="' + x[0] + '"><span class="rg-radio"></span><div><strong>' + esc(x[1]) + "</strong><span>" + esc(x[2]) + "</span></div></button>"; }).join("") + "</div>" +
        '<div class="rg-ajustes"><label>Meta <input type="number" id="rg-lote-meta" value="' + estado.meta + '" step="0.5"> %</label><label>Não aumentar mais que <input type="number" id="rg-lote-teto" value="' + L.teto + '"> %</label><label><input type="checkbox" id="rg-lote-90"' + (L.fim90 ? " checked" : "") + "> Terminar em ,90 (preços preliminares)</label></div>" +
        '<div class="rg-rodape"><span class="rg-mudo">Sem consultas ao Mercado Livre: usa a auditoria e a recotação já feita.</span><button class="vf-btn vf-btn--primary" type="button" data-rg-lote-simular' + (n ? "" : " disabled") + ">Simular " + n + " anúncios →</button></div>";
    } else if (!L.resultado) html += '<div class="vf-loading-state"><span class="vf-spinner vf-spinner--sm"></span> Preparando propostas…</div>';
    else if (L.resultado.erro) html += "<p>" + esc(L.resultado.erro) + '</p><button class="vf-btn vf-btn--ghost" type="button" data-rg-lote-passo="1">← Voltar</button>';
    else if (L.passo === 2) {
      var r = L.resultado, por = {}; r.excecoes.forEach(function (x) { (por[x.tipo] = por[x.tipo] || []).push(x); });
      html += '<div class="rg-placar"><div><b class="rg-pos">' + r.prontos.length + "</b><span>prontos (" + r.resumo.recotados + " com preço recotado)</span></div><div><b>" + (por.ACIMA_DO_TETO || []).length + "</b><span>pedem sua decisão</span></div><div><b>" + (r.excecoes.length - (por.ACIMA_DO_TETO || []).length) + "</b><span>ficam de fora</span></div></div>" +
        Object.keys(EXCECAO).filter(function (k) { return por[k]; }).map(function (k) { return '<div class="rg-excecao"><h3>' + esc(EXCECAO[k][0]) + " · " + por[k].length + '</h3><p class="rg-mudo">' + esc(EXCECAO[k][1]) + "</p>" + por[k].slice(0, 60).map(function (x) {
          return '<div class="rg-ex-linha"><div><span class="rg-t1">' + esc(x.titulo || x.itemId) + '</span><span class="rg-mudo">' + esc(x.itemId) + " · " + esc(x.motivo) + "</span></div>" + (k === "ACIMA_DO_TETO" ? '<span class="rg-seg"><button type="button" data-rg-incluir="' + esc(x.itemId) + ':1" class="' + (L.incluir[x.itemId] ? "is-ativo" : "") + '">Incluir</button><button type="button" data-rg-incluir="' + esc(x.itemId) + ':0" class="' + (L.incluir[x.itemId] ? "" : "is-ativo") + '">Deixar de fora</button></span>' : k === "NA_META" || k === "NAO_SE_APLICA" ? "<span></span>" : '<button class="vf-btn vf-btn--ghost vf-btn--sm" type="button" data-rg-item-lote="' + esc(x.itemId) + '">Resolver</button>') + "</div>"; }).join("") + (por[k].length > 60 ? '<p class="rg-mudo">+' + (por[k].length - 60) + " outros na planilha.</p>" : "") + "</div>"; }).join("") +
        '<div class="rg-rodape"><button class="vf-btn vf-btn--ghost" type="button" data-rg-lote-passo="1">← Estratégia</button><button class="vf-btn vf-btn--primary" type="button" data-rg-lote-passo="3">Revisar propostas →</button></div>';
    } else {
      var lst = listaLoteFinal(), ganho = lst.reduce(function (s, x) { return s + (vazio(x.lucroAtual) ? 0 : (x.lucroProposto - x.lucroAtual) * (x.unidades30d || 0)); }, 0);
      html += '<p>' + lst.length + ' propostas. Se as vendas se mantiverem, o lucro do mês subiria cerca de <b>' + moeda(r2(ganho)) + '</b> (estimativa).</p><div class="rg-props">' + lst.map(function (x) { var sp = seloPreco(x.tipo || x.tipoPreco); return '<div class="rg-prop"><div class="rg-prop__t"><b>' + esc(curto(x.titulo, 70)) + '</b><span class="rg-mudo">' + esc(x.itemId) + " · " + esc(x.acao) + '</span></div><div class="rg-prop__p rg-n">' + moeda(x.precoAtual) + " → " + moeda(x.precoProposto) + '</div><div class="rg-prop__m">' + pct(x.margemAtual) + " → <b>" + pct(x.margemProposta) + '</b> <span class="rg-marca rg-marca--' + sp.cls + '">' + sp.txt + "</span></div></div>"; }).join("") + "</div>" +
        '<div class="rg-rodape"><button class="vf-btn vf-btn--ghost" type="button" data-rg-lote-passo="2">← Exceções</button><span class="rg-ok__acoes"><button class="vf-btn vf-btn--secondary" type="button" data-rg-lote-csv>Baixar planilha</button><button class="vf-btn vf-btn--primary" type="button" data-rg-lote-registrar' + (lst.length ? "" : " disabled") + ">Registrar " + lst.length + " propostas</button></span></div>";
    }
    return html + "</div>";
  }
  function listaLoteFinal() { var r = estado.lote.resultado; if (!r || r.erro) return []; return r.prontos.concat(r.excecoes.filter(function (x) { return x.tipo === "ACIMA_DO_TETO" && estado.lote.incluir[x.itemId]; })); }
  function simularLote() {
    var L = estado.lote; L.passo = 2; L.resultado = null; renderBancada();
    return chamar("/resgate/contas/" + estado.contaId + "/propostas", { method: "POST", body: { itemIds: selecionados(), estrategia: L.estrategia, meta: estado.meta, tetoAumento: L.teto, terminarEm90: L.fim90 } }).then(function (r) {
      L.resultado = r.ok ? r.data : { erro: (r.data && r.data.motivo) || "Não foi possível preparar as propostas." }; renderBancada();
    });
  }
  /** Registra cada proposta na revisão do anúncio, uma a uma (protegido pelo preço visto). Nada vai ao ML. */
  function registrarLote() {
    var lst = listaLoteFinal(), ok = 0, local = 0, falhas = [], k = 0;
    function prox() {
      if (k >= lst.length) { guardarPropostas(); renderLista(); toast(ok + " registrada(s) na revisão" + (local ? ", " + local + " só neste navegador" : "") + (falhas.length ? ", " + falhas.length + " recusada(s) (preço mudou)" : "") + ". Nada foi enviado ao Mercado Livre.", falhas.length ? "warning" : "success"); estado.sel = {}; fecharBancada(); return; }
      var x = lst[k++], tipo = x.tipo === "ACIMA_DO_TETO" ? x.tipoPreco : x.tipo;
      var nota = ("Proposta em lote: " + x.acao + " para " + moeda(x.precoProposto) + " · " + (tipo === "RECOTADO" ? "recotado" : "preliminar") + " · margem " + pct(x.margemProposta)).slice(0, 500);
      return chamar("/resgate/contas/" + estado.contaId + "/itens/" + encodeURIComponent(x.itemId) + "/revisao", { method: "POST", body: { status: tipo === "RECOTADO" ? "APROVADO" : "PENDENTE", nota: nota, precoVisto: x.precoVisto } }).then(function (r) {
        if (r.ok) ok++; else if (r.status === 501) local++; else { falhas.push(x.itemId); return prox(); }
        propostas = propostas.filter(function (p) { return !(p.conta === estado.contaId && p.id === x.itemId); });
        propostas.push({ conta: estado.contaId, id: x.itemId, titulo: curto(x.titulo, 70), texto: x.acao + " para " + moeda(x.precoProposto), preco: x.precoProposto, margem: x.margemProposta, situacao: tipo, em: new Date().toISOString(), servidor: r.ok });
        return prox();
      });
    }
    return prox();
  }

  // ── Avançado: todas as contas e plano de ativação (mantido do Resgate atual) ──
  function renderAvancado() {
    var d = estado.global || {}, t = d.totais || {};
    $("rg-avancado").innerHTML = '<div class="vf-kpi-grid rg-kpis">' + [["Contas avaliadas", t.contasAvaliadas], ["Sem avaliação", t.contasSemAvaliacao], ["Anúncios auditados", t.anunciosAuditados], ["Alterados recentemente", t.alteradosRecentemente]].map(function (k) { return '<div class="vf-kpi"><div class="vf-kpi__label">' + esc(k[0]) + '</div><div class="vf-kpi__value">' + inteiro(k[1]) + "</div></div>"; }).join("") + "</div>" +
      '<div class="vf-table-wrap"><table class="vf-table vf-table--compact"><thead><tr><th>Cliente / conta</th><th class="rg-n">Anúncios</th><th class="rg-n">Revisar</th><th class="rg-n">Sem margem confiável</th><th>Cotador</th></tr></thead><tbody>' +
      (d.contas || []).map(function (c) { return c.semAvaliacao ? '<tr><td>' + esc(c.clienteNome) + ' <span class="rg-mudo">' + esc(c.contaNome || "") + '</span></td><td colspan="4" class="rg-mudo">Sem avaliação: ' + esc(c.semAvaliacao) + "</td></tr>" : '<tr class="rg-clicavel" data-rg-conta="' + esc(c.clienteContaId) + '"><td>' + esc(c.clienteNome) + ' <span class="rg-mudo">' + esc(c.contaNome || "") + '</span></td><td class="rg-n">' + inteiro(c.itens) + '</td><td class="rg-n">' + inteiro(c.precisamRevisao) + '</td><td class="rg-n">' + inteiro(c.semMargemConfiavel) + "</td><td>" + esc(c.matriz && c.matriz.decisao || c.decisaoAtivacao || "—") + "</td></tr>"; }).join("") + "</tbody></table></div>";
  }
  // ── Ações: um único caminho de escrita ──────────────────────────────────
  function podeAgir(ctx, cfg) { return Boolean(cfg && cfg.acoesHabilitadas && !cfg.preview && ctx && ctx.acoesHabilitadas && !ctx.preview && ctx.clienteSlug); }
  function motivoSemAcoes(ctx, cfg) {
    if ((cfg && cfg.preview) || (ctx && ctx.preview)) return "Preview local: somente leitura. Nenhuma ação é enviada ao Mercado Livre.";
    if (!(cfg && cfg.acoesHabilitadas) || !(ctx && ctx.acoesHabilitadas)) return "Ações no Mercado Livre desligadas neste ambiente. Simule e revise; a execução exige autorização.";
    if (!(ctx && ctx.clienteSlug)) return "Cliente da conta não identificado: ações indisponíveis.";
    return "";
  }
  /** Ação → chamada do endpoint EXISTENTE de /anuncios-meli (puro, testável). */
  function planoDaAcao(acao, ctx, itemId) {
    var base = { clienteSlug: ctx.clienteSlug, clienteContaId: ctx.clienteContaId };
    var id = encodeURIComponent(itemId), pid = encodeURIComponent(acao.promocaoId || "");
    if (acao.tipo === "ALTERAR_PRECO") return { method: "PATCH", url: "/anuncios-meli/" + id + "/preco", body: Object.assign({}, base, { preco: acao.precoAlvo }) };
    if (acao.tipo === "ALTERAR_PRECO_PROMOCIONAL") return { method: "POST", url: "/anuncios-meli/" + id + "/promocoes/" + pid + "/aplicar", body: Object.assign({}, base, { precoNovo: acao.precoAlvo, alterarParticipacao: true }) };
    if (acao.tipo === "SAIR_DA_PROMOCAO") return { method: "POST", url: "/anuncios-meli/" + id + "/promocoes/" + pid + "/sair", body: Object.assign({}, base, { tipo: acao.promocaoTipo || null }) };
    if (acao.tipo === "PARTICIPAR") return { method: "POST", url: "/anuncios-meli/" + id + "/promocoes/" + pid + "/participar", body: Object.assign({}, base, { tipo: acao.promocaoTipo || null }) };
    return null;
  }
  /** Releitura (GET leve do /anuncios-meli) comparada ao preço visto. Mudou → proposta inválida. */
  function conferirReleitura(acao, b, relido) {
    if (!relido || vazio(relido.precoAtual)) return { ok: false, motivo: "Não foi possível reler o preço atual no Mercado Livre: nada foi enviado." };
    var visto = b.precos && b.precos.comprador;
    if (vazio(visto) || Math.abs(Number(relido.precoAtual) - Number(visto)) >= 0.01) return { ok: false, motivo: "O preço mudou desde a análise (" + moeda(visto) + " → " + moeda(relido.precoAtual) + "): proposta invalidada. Reabra o anúncio e recote." };
    if (acao.requerAntes === "SAIR_DA_PROMOCAO" && !vazio(relido.precoOriginal)) return { ok: false, motivo: "O anúncio ainda está em promoção: saia da promoção antes de alterar o preço cheio." };
    return { ok: true };
  }
  function modalHtml(acao, b, relido, conferencia) {
    var depois = acao.tipo === "SAIR_DA_PROMOCAO" ? (acao.resultadoEsperado ? moeda(acao.resultadoEsperado.precoComprador) : "preço cheio") : moeda(acao.precoAlvo);
    var margemDepois = acao.tipo === "SAIR_DA_PROMOCAO" ? (acao.resultadoEsperado && acao.resultadoEsperado.recotado ? pct(acao.resultadoEsperado.margemPercent) : "não recotada")
      : acao.margemRecotadaPercent !== undefined && acao.margemRecotadaPercent !== null ? pct(acao.margemRecotadaPercent)
      : (b.sugerido && b.sugerido.status === "RECOTADO" && Math.abs(Number(b.sugerido.preco) - Number(acao.precoAlvo)) < 0.005 ? pct(b.sugerido.margemPercent) : "não recotada");
    return "<p><strong>" + esc(acao.rotulo || ACAO_ROTULO[acao.tipo]) + "</strong></p>" +
      '<table class="vf-table vf-table--compact"><thead><tr><th></th><th class="rg-num">Agora (relido)</th><th class="rg-num">Depois</th></tr></thead><tbody>' +
      '<tr><td>Comprador paga</td><td class="rg-num">' + moeda(relido && relido.precoAtual) + '</td><td class="rg-num"><strong>' + depois + "</strong></td></tr>" +
      '<tr><td>Margem</td><td class="rg-num">' + pct(b.resultado && b.resultado.margemPercent) + '</td><td class="rg-num"><strong>' + margemDepois + "</strong></td></tr></tbody></table>" +
      (conferencia.ok ? '<p class="rg-sub">Será enviado pelo endpoint existente de Anúncios ML (' + esc(acao.endpoint || "") + "), com as mesmas travas da tela de Anúncios.</p>" +
        '<label class="vf-check"><input type="checkbox" id="rg-modal-ciente"> Revisei os valores e quero enviar esta alteração ao Mercado Livre.</label>'
        : '<div class="vf-banner vf-banner--compact"><div class="vf-banner__content"><div class="vf-banner__title">Ação bloqueada</div><div class="vf-banner__description">' + esc(conferencia.motivo) + "</div></div></div>");
  }

  function abrirModal(html, podeConfirmar) {
    $("rg-modal-corpo").innerHTML = html; $("rg-modal").classList.add("is-open"); $("rg-modal").setAttribute("aria-hidden", "false");
    var conf = $("rg-modal-confirmar"); conf.disabled = true; conf.hidden = !podeConfirmar;
    var ciente = $("rg-modal-ciente"); if (ciente) ciente.addEventListener("change", function () { conf.disabled = !ciente.checked; });
  }
  function fecharModal() { $("rg-modal").classList.remove("is-open"); $("rg-modal").setAttribute("aria-hidden", "true"); estado.acaoPendente = null; }

  /** Passo 1: travas + releitura do preço atual (GET leve) + modal de confirmação. Nada é enviado aqui. */
  function prepararAcao(acao) {
    var det = estado.aberto; if (!det || !acao) return Promise.resolve(null);
    var ctx = det.contexto || {};
    if (!podeAgir(ctx, estado.cfg)) { toast(motivoSemAcoes(ctx, estado.cfg), "warning"); return Promise.resolve(null); }
    if (acao.suportada === false) { toast(acao.motivoNaoSuportada || "Ação não suportada.", "warning"); return Promise.resolve(null); }
    var itemId = det.item.itemId;
    return chamar("/anuncios-meli/precos-ao-vivo" + buildQuery({ clienteSlug: ctx.clienteSlug, clienteContaId: ctx.clienteContaId, itemIds: itemId })).then(function (r) {
      var relido = r.ok && r.data && r.data.precos ? r.data.precos[itemId] : null;
      var conferencia = conferirReleitura(acao, det.bancada, relido);
      estado.acaoPendente = conferencia.ok ? { acao: acao, plano: planoDaAcao(acao, ctx, itemId), relido: relido } : null;
      abrirModal(modalHtml(acao, det.bancada, relido, conferencia), conferencia.ok);
      return conferencia;
    });
  }
  /** Passo 2: só depois do "Revisei" marcado no modal. Endpoint existente de /anuncios-meli. */
  function executarAcao() {
    var p = estado.acaoPendente, det = estado.aberto;
    var ciente = $("rg-modal-ciente");
    if (!p || !det || !p.plano || !ciente || !ciente.checked || !podeAgir(det.contexto, estado.cfg)) return Promise.resolve(null);
    $("rg-modal-confirmar").disabled = true;
    return chamar(p.plano.url, { method: p.plano.method, body: p.plano.body }).then(function (r) {
      fecharModal();
      if (!r.ok) { toast((r.data && r.data.motivo) || "O Mercado Livre recusou a alteração. Nada foi alterado.", "danger"); return r; }
      toast("Enviado ao Mercado Livre e confirmado pela tela de Anúncios.", "success");
      return chamar(urlItem("/revisao"), { method: "POST", body: { status: "AJUSTADO", precoVisto: det.item.fingerprint && det.item.fingerprint.precoVisto, nota: (ACAO_ROTULO[p.acao.tipo] || p.acao.tipo) + (p.acao.precoAlvo ? " → " + p.acao.precoAlvo : "") } })
        .then(function () { return abrirItem(det.item.itemId, "resumo"); }).then(function () { return r; });
    });
  }


  function iniciar() {
    if (!root.document || !$("rg-app")) return;
    var metaSalva = Number(lerPreferencia("vf-resgate-meta", "15"));
    estado.meta = isFinite(metaSalva) && metaSalva > 0 && metaSalva < 90 ? metaSalva : 15;
    $("rg-meta").value = String(estado.meta);
    carregarPropostas();
    root.document.addEventListener("click", function (ev) {
      var t = ev.target.closest && ev.target.closest("button,[data-rg-item],[data-rg-pedido],[data-rg-conta]");
      if (!t || t.disabled) return;
      var d = t.dataset;
      if (ev.target.matches && ev.target.matches("input[type=checkbox]")) return;
      if (d.rgModo) { estado.modo = d.rgModo; render(); }
      else if (d.rgConta) { estado.modo = "operacao"; abrirConta(d.rgConta); }
      else if (d.rgAba !== undefined) { estado.aba = d.rgAba; estado.pagina = 1; atualizarHash(); carregarLista(); }
      else if (d.rgPag) { estado.pagina += Number(d.rgPag); carregarLista(); }
      else if (d.rgItemLote) { estado.loteAberto = false; abrirItem(d.rgItemLote); }
      else if (d.rgItem) abrirItem(d.rgItem);
      else if (d.rgMover) mover(Number(d.rgMover));
      else if (t.hasAttribute("data-rg-fechar")) fecharBancada();
      else if (d.rgAbaB) { estado.aba_b = d.rgAbaB; estado.salvo = null; if (d.rgAbaB === "pedidos" && !estado.pedidos) carregarPedidos(); renderBancada(); atualizarHash(); }
      else if (d.rgIrOpcao) { estado.opcao = d.rgIrOpcao; estado.preco = null; estado.sim = null; var o = opcaoAtual(); if (o.tipo === "manter") dialogoRegistrar(); else { estado.aba_b = o.tipo === "comparar" ? "promocoes" : "precificar"; renderBancada(); } }
      else if (d.rgOpcao) { estado.opcao = d.rgOpcao; estado.preco = null; estado.sim = null; if (opcaoAtual().tipo === "comparar") estado.aba_b = "promocoes"; renderBancada(); }
      else if (d.rgAjuste) { estado.preco = r2(Math.max(1, Number(estado.preco) + Number(d.rgAjuste))); $("rg-sim-preco").value = estado.preco.toFixed(2).replace(".", ","); estado.sim = null; agendarSimulacao(); }
      else if (d.rgPreco) { estado.preco = Number(d.rgPreco); $("rg-sim-preco").value = estado.preco.toFixed(2).replace(".", ","); estado.sim = null; agendarSimulacao(0); }
      else if (t.hasAttribute("data-rg-recotar")) recotar();
      else if (t.hasAttribute("data-rg-ler-promos")) lerPromocoesVivas();
      else if (d.rgPromoSel) { estado.promoSel = d.rgPromoSel; renderBancada(); }
      else if (t.hasAttribute("data-rg-propor-promo")) { estado.opcao = "comparar"; dialogoRegistrar(); }
      else if (d.rgPedido !== undefined) abrirPedido(d.rgPedido);
      else if (t.hasAttribute("data-rg-pre-registrar")) dialogoRegistrar();
      else if (t.hasAttribute("data-rg-registrar")) registrar();
      else if (t.hasAttribute("data-rg-dlg-fechar")) $("rg-dialogo").hidden = true;
      else if (d.rgAcaoReal !== undefined) { var x = proposta(); prepararAcao(x.acoes[Number(d.rgAcaoReal)]); }
      else if (t.hasAttribute("data-rg-ver-propostas")) painelPropostas();
      else if (t.hasAttribute("data-rg-painel-fechar") || t.id === "rg-painel-fundo") fecharPainel();
      else if (t.hasAttribute("data-rg-csv")) baixarCsv("resgate_propostas_conta" + estado.contaId + ".csv", [["conta", "mlb", "proposta", "preco", "margem", "situacao", "registrada_no_servidor", "em"]].concat(propostas.filter(function (p) { return p.conta === estado.contaId; }).map(function (p) { return [p.conta, p.id, p.texto, p.preco, p.margem, p.situacao, p.servidor ? "sim" : "não", p.em]; })));
      else if (t.hasAttribute("data-rg-limpar-propostas")) { propostas = propostas.filter(function (p) { return p.conta !== estado.contaId; }); guardarPropostas(); painelPropostas(); renderLista(); }
      else if (t.id === "rg-lote-ir") abrirLote();
      else if (t.id === "rg-lote-limpar") { estado.sel = {}; renderLista(); }
      else if (t.id === "rg-lote-filtro") selecionarFiltroInteiro();
      else if (d.rgEstrategia) { estado.lote.estrategia = d.rgEstrategia; renderBancada(); }
      else if (t.hasAttribute("data-rg-lote-simular")) simularLote();
      else if (d.rgLotePasso) { estado.lote.passo = Number(d.rgLotePasso); if (estado.lote.passo === 1) estado.lote.resultado = null; renderBancada(); }
      else if (d.rgIncluir) { var kv = d.rgIncluir.split(":"); estado.lote.incluir[kv[0]] = kv[1] === "1"; renderBancada(); }
      else if (t.hasAttribute("data-rg-lote-registrar")) registrarLote();
      else if (t.hasAttribute("data-rg-lote-csv")) baixarCsv("resgate_lote_conta" + estado.contaId + ".csv", [["conta", "mlb", "acao", "preco_hoje", "preco_proposto", "margem_hoje", "margem_proposta", "preco"]].concat(listaLoteFinal().map(function (x) { return [estado.contaId, x.itemId, x.acao, x.precoAtual, x.precoProposto, x.margemAtual, x.margemProposta, (x.tipo === "ACIMA_DO_TETO" ? x.tipoPreco : x.tipo) === "RECOTADO" ? "recotado" : "preliminar"]; })));
      else if (t.id === "rg-modal-cancelar") fecharModal();
      else if (t.id === "rg-modal-confirmar") executarAcao();
    });
    root.document.addEventListener("change", function (ev) {
      var t = ev.target;
      if (t.dataset && t.dataset.rgSel) { estado.sel[t.dataset.rgSel] = t.checked; renderBarraLote(); }
      else if (t.id === "rg-todos") { itensVisiveis().forEach(function (x) { estado.sel[x.itemId] = t.checked; }); renderLista(); }
      else if (t.id === "rg-ordem") { estado.ordem = t.value; renderLista(); }
      else if (t.id === "rg-conta") abrirConta(t.value);
      else if (t.id === "rg-meta" || t.id === "rg-lote-meta") { var n = lerNumero(t.value); if (n === null || n >= 90) { t.value = String(estado.meta); return; } estado.meta = n; $("rg-meta").value = String(n); gravarPreferencia("vf-resgate-meta", String(n)); if (t.id === "rg-meta") { carregarLista(); if (estado.aberto && estado.aberto.item) abrirItem(estado.aberto.item.itemId, estado.aba_b); } }
      else if (t.id === "rg-lote-teto") estado.lote.teto = Number(t.value) || 30;
      else if (t.id === "rg-lote-90") estado.lote.fim90 = t.checked;
    });
    var timer = null;
    root.document.addEventListener("input", function (ev) {
      var t = ev.target;
      if (t.id === "rg-busca") { var v = t.value.trim(); clearTimeout(timer); timer = setTimeout(function () { estado.busca = v; estado.pagina = 1; carregarLista(); }, 350); }
      else if (t.id === "rg-sim-preco") { var p = lerNumero(t.value); if (p) { estado.preco = p; estado.sim = null; agendarSimulacao(); } }
    });
    root.document.addEventListener("keydown", function (ev) {
      var t = ev.target;
      if (ev.key === "Escape") { if ($("rg-modal").classList.contains("is-open")) fecharModal(); else if (!$("rg-dialogo").hidden) $("rg-dialogo").hidden = true; else if (!$("rg-painel").hidden) fecharPainel(); else if (estado.aberto || estado.loteAberto) fecharBancada(); return; }
      if (t.matches && t.matches("input,select,textarea")) return;
      if (ev.key === "/") { ev.preventDefault(); $("rg-busca").focus(); }
      else if (ev.key === "ArrowDown" || ev.key === "j") { ev.preventDefault(); if (estado.aberto) mover(1); else { var l = itensVisiveis(); if (l[0]) abrirItem(l[0].itemId); } }
      else if (ev.key === "ArrowUp" || ev.key === "k") { ev.preventDefault(); if (estado.aberto) mover(-1); }
      else if (ev.key === "Enter" && t.dataset && t.dataset.rgItem) abrirItem(t.dataset.rgItem);
    });
    $("rg-xlsx-conta").addEventListener("click", function (ev) {
      ev.preventDefault();
      root.fetch(apiBase() + "/resgate/contas/" + estado.contaId + "/plano.xlsx", { headers: { Authorization: "Bearer " + token() } }).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.blob(); })
        .then(function (b) { var a = root.document.createElement("a"); a.href = URL.createObjectURL(b); a.download = "venforce-resgate-conta-" + estado.contaId + ".xlsx"; a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000); })
        .catch(function (e) { toast("Erro ao baixar: " + e.message, "danger"); });
    });
    chamar("/resgate/config").then(function (c) {
      if (c.ok) estado.cfg = { acoesHabilitadas: Boolean(c.data.acoesHabilitadas), preview: Boolean(c.data.preview), recotacaoSobDemanda: Boolean(c.data.recotacaoSobDemanda), simulacaoPreliminar: Boolean(c.data.simulacaoPreliminar) };
      renderModo();
      return chamar("/resgate/visao-global");
    }).then(function (r) {
      if (!r.ok) { $("rg-linhas").innerHTML = '<tr><td colspan="7"><div class="vf-banner"><div class="vf-banner__content"><div class="vf-banner__title">Resgate indisponível</div><div class="vf-banner__description">' + esc(r.data && r.data.motivo || "Erro ao carregar.") + "</div></div></div></td></tr>"; return; }
      estado.global = r.data;
      var contas = (r.data.contas || []).filter(function (c) { return !c.semAvaliacao; }).sort(function (a, z) { return (Number(z.precisamRevisao) || 0) - (Number(a.precisamRevisao) || 0) || String(a.clienteNome).localeCompare(String(z.clienteNome)); });
      $("rg-conta").innerHTML = contas.map(function (c) { return '<option value="' + esc(c.clienteContaId) + '">' + esc((c.clienteNome || "Cliente") + (c.contaNome ? " — " + c.contaNome : "")) + "</option>"; }).join("");
      if (!contas.length) { $("rg-linhas").innerHTML = '<tr><td colspan="7"><div class="vf-empty"><div class="vf-empty__title">Nenhuma conta auditada na sua carteira.</div><div class="vf-empty__description">No preview local, confira a pasta passada em --dados.</div></div></td></tr>'; return; }
      var h = new URLSearchParams(String(root.location && root.location.hash || "").replace(/^#/, ""));
      if (h.get("filtro")) estado.aba = h.get("filtro") === "todos" ? "" : h.get("filtro");
      var alvo = h.get("conta") || String(contas[0].clienteContaId);
      abrirConta(alvo).then(function () { if (h.get("item")) abrirItem(h.get("item"), h.get("aba") || "resumo"); });
    });
  }
  function abrirConta(id) {
    estado.contaId = Number(id); $("rg-conta").value = String(estado.contaId); estado.pagina = 1; estado.sel = {}; estado.contagens = {};
    estado.aberto = null; estado.loteAberto = false; $("rg-bancada").classList.remove("is-aberta"); contarPropostas(); atualizarHash(); render();
    return carregarLista();
  }

  return {
    iniciar: iniciar, moeda: moeda, pct: pct, inteiro: inteiro, esc: esc, buildQuery: buildQuery, lerNumero: lerNumero, lerPrecos: lerPrecos,
    situacao: situacao, entender: entender, opcoes: opcoes, linhaTabelaHtml: linhaTabelaHtml, identificarHtml: identificarHtml, antesDepoisHtml: antesDepoisHtml, normalizarSim: normalizarSim,
    linhasPromocao: linhasPromocao, compararHtml: compararHtml, painelCalculoHtml: painelCalculoHtml, painelEvidenciasHtml: painelEvidenciasHtml, painelPedidosHtml: painelPedidosHtml, detalhePedidoHtml: detalhePedidoHtml,
    seloFrete: seloFrete, seloPreco: seloPreco, planoDaAcao: planoDaAcao, conferirReleitura: conferirReleitura, podeAgir: podeAgir, modalHtml: modalHtml,
    _estado: estado, _prepararAcao: prepararAcao, _executarAcao: executarAcao, _proposta: proposta, STATUS: STATUS,
  };
});
