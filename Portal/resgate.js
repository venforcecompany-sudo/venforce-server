/*
 * VenForce Resgate — central de recuperação de preço e margem.
 * Fluxo: conta → anúncio → margem → simular → revisar → confirmar.
 *
 * Regras da tela:
 *   · Só EXIBE a bancada calculada no servidor (resgate-bancada/1): nenhuma
 *     fórmula financeira aqui; ausente = "—", nunca 0.
 *   · Simular e recotar: POST /resgate/.../simular (somente GET no ML).
 *   · Ações reais: SOMENTE pelos endpoints existentes de /anuncios-meli, por um
 *     único caminho (executarAcao) que exige: ações habilitadas pelo servidor,
 *     fora do preview, releitura do preço atual igual ao preço visto, e
 *     confirmação explícita no modal. Padrão: desligadas.
 */
(function (root, factory) {
  var api = factory(root || {});
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.VFResgate = api; if (root.document) root.document.addEventListener("DOMContentLoaded", function () { api.iniciar(); }); }
})(typeof window !== "undefined" ? window : globalThis, function (root) {
  "use strict";

  var DEFAULT_API_BASE = "https://venforce-server.onrender.com";
  var STATUS = {
    OK: ["Na meta", "success"], ABAIXO_DA_META: ["Abaixo da meta", "warning"], PREJUIZO: ["Prejuízo", "danger"],
    MARGEM_DESCONHECIDA: ["Margem desconhecida", "neutral"], BLOQUEADO: ["Sem cálculo", "neutral"],
  };
  var FINANCIAMENTO = { VENDEDOR_100: "Vendedor paga 100%", ML_COFINANCIA: "ML cofinancia", NAO_DETERMINADO: "Financiamento não comprovado" };
  var ACAO_ROTULO = { ALTERAR_PRECO: "Alterar preço", ALTERAR_PRECO_PROMOCIONAL: "Alterar preço promocional", SAIR_DA_PROMOCAO: "Sair da promoção", PARTICIPAR: "Participar da promoção" };
  var REVISAO = { PENDENTE: ["Pendente", "neutral"], APROVADO: ["Aprovado", "success"], AJUSTADO: ["Ajustado", "primary"], REJEITADO: ["Rejeitado", "neutral"], INVALIDADO: ["Invalidado (preço mudou)", "warning"] };
  var CONFIANCAS = { alta: "alta", media: "média", baixa: "baixa", nao_verificada: "não verificada", desconhecida: "desconhecida", nao_aplicavel: "não se aplica" };

  // ── Formatação (ausente = "—", nunca 0) ─────────────────────────────────
  function vazio(v) { return v === null || v === undefined || v === "" || (typeof v === "number" && !isFinite(v)); }
  function moeda(v) { return vazio(v) ? "—" : "R$ " + Number(v).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function pct(v) { return vazio(v) ? "—" : Number(v).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + "%"; }
  function pctFracao(v) { return vazio(v) ? "—" : pct(Number(v) * 100); }
  function inteiro(v) { return vazio(v) ? "—" : Number(v).toLocaleString("pt-BR"); }
  function data(v) { if (vazio(v)) return "—"; var d = new Date(v); return isNaN(d.getTime()) ? "—" : d.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }); }
  function esc(s) { return String(s === null || s === undefined ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function tag(texto, tom) { return '<span class="vf-tag is-' + esc(tom || "neutral") + '">' + esc(texto) + "</span>"; }
  function statusTag(s) { var x = STATUS[s] || [s || "—", "neutral"]; return tag(x[0], x[1]); }
  function lerNumero(texto) { var s = String(texto === null || texto === undefined ? "" : texto).trim().replace(/\s/g, ""); if (!s) return null; if (s.indexOf(",") >= 0) s = s.replace(/\./g, "").replace(",", "."); var n = Number(s); return isFinite(n) && n > 0 ? n : null; }
  function lerPrecos(texto) { return String(texto || "").split(/[;\s]+/).map(lerNumero).filter(function (n) { return n !== null; }).slice(0, 8); }

  function buildQuery(params) {
    var q = new URLSearchParams();
    Object.keys(params || {}).forEach(function (k) { var v = params[k]; if (v === null || v === undefined || v === "" || v === false) return; q.set(k, v === true ? "1" : String(v)); });
    var s = q.toString();
    return s ? "?" + s : "";
  }

  // ── Lista ───────────────────────────────────────────────────────────────
  function linhaItem(x) {
    var b = x.bancada || {};
    var promo = b.promocao ? '<span class="rg-sub">' + esc(b.promocao.tipoRotulo || "Promoção") + "</span><br>" + esc(FINANCIAMENTO[b.promocao.financiamento] || "—") : '<span class="rg-sub">Sem promoção</span>';
    var sug = b.sugerido && b.sugerido.preco !== null && b.sugerido.preco !== undefined
      ? moeda(b.sugerido.preco) + '<br><span class="rg-sub">' + (b.sugerido.status === "RECOTADO" ? "recotado no ML" : "preliminar") + "</span>" : "—";
    var margem = (b.limiteInferior ? '<span class="rg-sub" title="Sem o subsídio do ML, que não foi comprovado">mín. </span>' : "") + pct(b.margemPercent);
    return '<tr class="rg-linha" tabindex="0" data-rg-item="' + esc(x.itemId) + '">' +
      '<td><div class="rg-anuncio"><strong>' + esc(x.itemId) + '</strong><span class="rg-sub vf-truncate">' + esc(x.titulo || "") + "</span>" +
        '<span class="rg-sub">' + (x.sku ? "SKU " + esc(x.sku) : "sem SKU") + (b.mudancaRecente ? " · " + tag("alterado recentemente", "info") : "") + (b.precoMudou ? " · " + tag("preço mudou", "warning") : "") + "</span></div></td>" +
      '<td class="rg-num">' + moeda(b.precoComprador) + (b.promocao && !vazio(b.precoCheio) ? '<br><span class="rg-sub rg-riscado">' + moeda(b.precoCheio) + "</span>" : "") + "</td>" +
      '<td class="rg-num">' + margem + "<br>" + statusTag(b.status) + "</td>" +
      "<td>" + promo + "</td>" +
      '<td class="rg-num">' + sug + "</td>" +
      '<td class="rg-motivo"><span class="rg-proximo">' + esc(b.proximoPasso || "") + '</span><span class="rg-sub">' + esc(b.motivoStatus || "") + "</span></td></tr>";
  }

  // ── Bancada ─────────────────────────────────────────────────────────────
  var OPERACAO = { base: "", menos: "−", mais: "+", igual: "=" };
  function cascataHtml(b) {
    return '<ol class="rg-cascata">' + (b.cascata || []).map(function (l) {
      var valor = l.status === "nao_aplicavel" ? '<span class="rg-sub">não se aplica</span>' : moeda(l.valor);
      var sub = [l.fonte, l.confianca ? "confiança " + (CONFIANCAS[l.confianca] || l.confianca) : null, l.nota].filter(Boolean).map(esc).join(" · ");
      return '<li class="rg-cascata__linha rg-cascata__linha--' + esc(l.operacao) + (l.chave === "lucro" ? " rg-cascata__linha--total" : "") + '" data-rg-linha="' + esc(l.chave) + '">' +
        '<span class="rg-cascata__op" aria-hidden="true">' + (OPERACAO[l.operacao] || "") + '</span><span class="rg-cascata__rotulo">' + esc(l.rotulo) + (sub ? '<span class="rg-sub">' + sub + "</span>" : "") + "</span>" +
        '<span class="rg-cascata__valor rg-num">' + valor + "</span></li>";
    }).join("") + "</ol>";
  }

  function precosHtml(b) {
    var p = b.precos || {};
    var m = function (rotulo, valor, nota) { return '<div class="vf-metric"><div class="vf-metric__label">' + esc(rotulo) + '</div><div class="vf-metric__value">' + valor + "</div>" + (nota ? '<div class="vf-metric__foot">' + esc(nota) + "</div>" : "") + "</div>"; };
    return '<div class="vf-metric-row rg-precos">' +
      m("Preço cheio do vendedor", moeda(p.cheio)) +
      m("Promocional do vendedor", moeda(p.promocionalVendedor), b.promocao && b.promocao.ativa && vazio(p.promocionalVendedor) ? "não é uma promoção 100% do vendedor" : null) +
      m("Comprador paga", moeda(p.comprador)) +
      m("Subsídio ML comprovado", b.promocao && b.promocao.ativa ? (b.promocao.comprovado ? moeda(b.promocao.subsidio) : "não comprovado") : "—") +
      "</div>";
  }

  function resultadoHtml(b) {
    var r = b.resultado || {};
    return '<div class="rg-resultado">' +
      '<div><div class="rg-resultado__rotulo">' + (r.limiteInferior ? "Margem mínima" : "Margem") + '</div><div class="rg-resultado__valor">' + pct(r.margemPercent) + "</div></div>" +
      '<div><div class="rg-resultado__rotulo">' + (r.limiteInferior ? "Lucro mínimo /un" : "Lucro /un") + '</div><div class="rg-resultado__valor">' + moeda(r.lucro) + "</div></div>" +
      '<div><div class="rg-resultado__rotulo">Meta</div><div class="rg-resultado__valor">' + pctFracao(b.meta && b.meta.valor) + "</div></div>" +
      '<div class="rg-resultado__status">' + statusTag(b.status) + '<p class="rg-sub">' + esc(b.motivoStatus || "") + "</p></div></div>";
  }

  function promocaoHtml(b) {
    var p = b.promocao || {};
    if (!p.ativa) return '<p class="rg-sub">Sem promoção ativa: o comprador paga o preço cheio.</p>';
    return '<div class="rg-promo"><div><strong>' + esc(p.tipoRotulo || p.tipo || "Promoção ativa") + "</strong>" + (p.nome ? " · " + esc(p.nome) : "") + (p.id ? ' <span class="rg-sub">' + esc(p.id) + "</span>" : "") + "</div>" +
      "<div>" + tag(FINANCIAMENTO[p.financiamento] || "—", p.comprovado ? "primary" : "warning") + " " + esc(p.texto || "") + "</div>" +
      (p.fonte ? '<div class="rg-sub">Evidência: ' + esc(p.fonte) + "</div>" : "") + "</div>";
  }

  function sugeridoHtml(b, cfg) {
    var s = b.sugerido || {};
    var recotar = '<button class="vf-btn vf-btn--secondary vf-btn--sm" type="button" data-rg-recotar' + (cfg && cfg.recotacaoSobDemanda ? "" : ' disabled title="Indisponível neste ambiente (sem leitura ao vivo do ML)"') + ">Recotar no ML (somente leitura)</button>";
    if (s.status === "NAO_NECESSARIO") return '<p class="rg-sub">' + (b.status === "OK" ? "Margem na meta: nenhum preço novo é necessário." : "Sem preço sugerido: resolva os bloqueios primeiro.") + "</p>";
    if (s.status === "RECOTADO") {
      return '<div class="rg-sugerido rg-sugerido--ok"><div class="rg-sugerido__preco">' + moeda(s.preco) + '</div><div>' + tag("Recotado no ML", "success") + " margem " + pct(s.margemPercent) + " · comissão " + moeda(s.comissao) + " · frete " + moeda(s.frete) +
        '<div class="rg-sub">' + esc(s.texto || "") + " Recotado em " + data(s.recotadoEm) + ".</div></div></div>" + '<div class="vf-cluster">' + recotar + "</div>";
    }
    return '<div class="rg-sugerido"><div class="rg-sugerido__preco rg-sub">' + moeda(s.preco) + '</div><div>' + tag("Simulação preliminar: não usar", "neutral") + '<div class="rg-sub">' + esc(s.texto || "") + "</div></div></div>" + '<div class="vf-cluster">' + recotar + "</div>";
  }

  function acoesHtml(b, ctx, cfg) {
    var habilitadas = podeAgir(ctx, cfg);
    var aviso = habilitadas ? "" : '<p class="rg-sub rg-aviso-acoes">' + esc(motivoSemAcoes(ctx, cfg)) + "</p>";
    if (!(b.acoes || []).length) return aviso + '<p class="rg-sub">Nenhuma ação de preço indicada para este anúncio.</p>';
    return aviso + '<ul class="rg-acoes">' + b.acoes.map(function (a, i) {
      var esperado = a.resultadoEsperado ? (a.resultadoEsperado.recotado ? "Comprador passaria a pagar " + moeda(a.resultadoEsperado.precoComprador) + " · margem " + pct(a.resultadoEsperado.margemPercent) + (a.resultadoEsperado.atingeMeta ? " (atinge a meta)" : " (abaixo da meta)") : "Comprador passaria a pagar " + moeda(a.resultadoEsperado.precoComprador) + " · margem ainda não recotada") : "";
      var bloqueio = a.suportada === false ? a.motivoNaoSuportada || "Ação não suportada pelo VenForce." : a.requerAntes ? "Requer antes: " + (ACAO_ROTULO[a.requerAntes] || a.requerAntes) + "." : "";
      return '<li class="rg-acao"><div><strong>' + esc(a.rotulo || ACAO_ROTULO[a.tipo] || a.tipo) + "</strong>" + (esperado ? '<div class="rg-sub">' + esc(esperado) + "</div>" : "") + (bloqueio ? '<div class="rg-sub">' + esc(bloqueio) + "</div>" : "") + (a.nota ? '<div class="rg-sub">' + esc(a.nota) + "</div>" : "") + "</div>" +
        '<button class="vf-btn vf-btn--secondary vf-btn--sm" type="button" data-rg-acao="' + i + '"' + (habilitadas && a.suportada !== false ? "" : " disabled") + ">Revisar e confirmar</button></li>";
    }).join("") + "</ul>";
  }

  function pendenciasHtml(b) {
    var l = (b.bloqueios || []).map(function (x) { return { t: x.texto, r: x.resolveCom, forte: true }; }).concat((b.pendencias || []).map(function (x) { return { t: x.texto, r: null }; }));
    if (!l.length) return "";
    return '<section class="rg-secao"><h3 class="rg-h3">Por que o cálculo está bloqueado ou incompleto</h3><ul class="rg-lista">' + l.map(function (x) { return "<li>" + (x.forte ? "<strong>" + esc(x.t) + "</strong>" : esc(x.t)) + (x.r ? '<div class="rg-sub">Resolve: ' + esc(x.r) + "</div>" : "") + "</li>"; }).join("") + "</ul></section>";
  }

  function revisaoHtml(item) {
    var st = (item.revisao && item.revisao.status) || "PENDENTE", r = REVISAO[st] || [st, "neutral"];
    return '<div class="rg-revisao"><div>Estado: ' + tag(r[0], r[1]) + (item.revisao && item.revisao.em ? ' <span class="rg-sub">' + data(item.revisao.em) + "</span>" : "") + '</div>' +
      '<p class="rg-sub">Vale só para o preço visto ' + moeda(item.fingerprint && item.fingerprint.precoVisto) + ". Se o preço mudar, a revisão é invalidada. Revisar não altera o anúncio.</p>" +
      '<div class="vf-cluster"><button class="vf-btn vf-btn--secondary vf-btn--sm" type="button" data-rg-revisar="APROVADO">Aprovar proposta</button><button class="vf-btn vf-btn--ghost vf-btn--sm" type="button" data-rg-revisar="AJUSTADO">Marcar como ajustado</button><button class="vf-btn vf-btn--ghost vf-btn--sm" type="button" data-rg-revisar="REJEITADO">Rejeitar</button></div></div>';
  }

  function detalhesTecnicosHtml(item) {
    var c = (item.contrato && item.contrato.componentes) || {};
    var nomes = [["precoCheio", "Preço cheio"], ["precoVigente", "Preço do comprador"], ["subsidioMl", "Subsídio ML (auditoria)"], ["comissao", "Comissão"], ["frete", "Frete"], ["custo", "Custo"], ["imposto", "Imposto"], ["taxaFixa", "Taxa fixa"]];
    var tl = (item.historico && item.historico.linhaDoTempo) || [];
    return '<details class="rg-detalhes"><summary>Detalhes técnicos e histórico</summary>' +
      '<table class="vf-table vf-table--compact"><thead><tr><th>Componente</th><th class="rg-num">Valor</th><th>Fonte</th><th>Confiança</th><th>Observado</th></tr></thead><tbody>' +
      nomes.map(function (n) { var x = c[n[0]] || {}; var v = n[0] === "imposto" ? pctFracao(x.valor) : moeda(x.valor); return "<tr><td>" + esc(n[1]) + '</td><td class="rg-num">' + v + "</td><td>" + esc(x.fonte || "—") + "</td><td>" + esc(CONFIANCAS[x.confianca] || x.confianca || "—") + "</td><td>" + data(x.observadoEm) + "</td></tr>"; }).join("") +
      "</tbody></table>" +
      '<p class="rg-sub">' + esc(item.historico && item.historico.motivo || "") + "</p>" +
      (tl.length ? '<ol class="rg-timeline">' + tl.map(function (e) { return '<li><span class="rg-sub">' + data(e.em) + "</span> " + esc(e.descricao || e.tipo) + (vazio(e.preco) ? "" : " · " + moeda(e.preco)) + ' <span class="rg-sub">(' + esc(e.fonte) + ")</span></li>"; }).join("") + "</ol>" : "") +
      "</details>";
  }

  var ABAS_BANCADA = [["margem", "Margem"], ["pedidos", "Pedidos"], ["precificar", "Precificar"]];
  function bancadaHtml(det, cfg, extra) {
    var b = det.bancada || {}, item = det.item || {}, ctx = det.contexto || {};
    var e = extra || {}, aba = e.aba || "margem";
    var painel = function (id, html) { return '<div class="rg-baba" data-rg-bpainel="' + id + '"' + (aba === id ? "" : " hidden") + ">" + html + "</div>"; };
    var nav = '<nav class="vf-tabs rg-btabs" role="tablist" aria-label="Seções do anúncio">' + ABAS_BANCADA.map(function (a) {
      return '<button class="vf-tab' + (aba === a[0] ? " is-active" : "") + '" role="tab" type="button" data-rg-baba="' + a[0] + '" aria-selected="' + (aba === a[0]) + '">' + a[1] + "</button>"; }).join("") + "</nav>";
    return '<div class="rg-bancada__corpo">' + nav +
      (b.precoMudou ? '<div class="vf-banner vf-banner--compact"><div class="vf-banner__content"><div class="vf-banner__title">Preço mudou desde a auditoria</div><div class="vf-banner__description">' + esc(b.precoMudou.texto) + "</div></div></div>" : "") +
      (e.aoVivo ? '<div class="rg-sub rg-aovivo">Atualizado ao vivo em ' + data(e.aoVivo) + " (somente leitura).</div>" : "") +
      painel("margem", precosHtml(b) + resultadoHtml(b) +
        '<section class="rg-secao"><h3 class="rg-h3">Composição da margem</h3>' + cascataHtml(b) + "</section>" +
        pendenciasHtml(b) +
        '<section class="rg-secao"><h3 class="rg-h3">Promoção</h3>' + promocaoHtml(b) + "</section>" +
        detalhesTecnicosHtml(item)) +
      painel("pedidos", '<div id="rg-pedidos"></div>') +
      painel("precificar",
        '<section class="rg-secao"><h3 class="rg-h3">Preço sugerido para a meta</h3>' + sugeridoHtml(b, cfg) + "</section>" +
        '<section class="rg-secao"><h3 class="rg-h3">Promoções disponíveis</h3><div class="vf-cluster rg-promo-acoes"><button class="vf-btn vf-btn--ghost vf-btn--sm" type="button" data-rg-ver-promocoes' + (ctx.clienteSlug && !ctx.preview ? "" : ' disabled title="Indisponível neste ambiente"') + ">Ver promoções disponíveis</button></div><div id=\"rg-promocoes\"></div></section>" +
        '<section class="rg-secao"><h3 class="rg-h3">Simular outro preço</h3>' +
          '<div class="vf-cluster"><label class="vf-visually-hidden" for="rg-sim-preco">Preço do comprador</label><div class="vf-input-group rg-sim-campo"><span class="vf-input-prefix">R$</span><input class="vf-input vf-input--sm" id="rg-sim-preco" inputmode="decimal" placeholder="' + esc(b.sugerido && b.sugerido.preco ? String(b.sugerido.preco).replace(".", ",") : "0,00") + '"></div>' +
          '<button class="vf-btn vf-btn--secondary vf-btn--sm" type="button" id="rg-sim-ir"' + (cfg && cfg.recotacaoSobDemanda ? "" : ' disabled title="Indisponível neste ambiente (sem leitura ao vivo do ML)"') + ">Simular (recota comissão e frete)</button></div>" +
          '<div id="rg-sim-saida"></div></section>' +
        '<section class="rg-secao"><h3 class="rg-h3">Ações</h3>' + acoesHtml(b, ctx, cfg) + "</section>" +
        '<section class="rg-secao"><h3 class="rg-h3">Revisão</h3>' + revisaoHtml(item) + "</section>") +
      "</div>";
  }

  // ── Pedidos reais do anúncio (Central de Vendas; somente leitura) ───────
  var MOTIVO_ERRO_PEDIDOS = { 409: "Esta conta não tem cliente vinculado: os pedidos da Central de Vendas não podem ser consultados.", 501: "Pedidos indisponíveis neste preview: não há fonte de pedidos local.", 503: "A Central de Vendas ainda não está disponível neste ambiente." };
  var COMP_ROTULO_SINAL = { debito: "−", credito: "+" };
  function sinalDiferenca(d) { var n = Number(d.diferenca), sg = n > 0 ? "+" : n < 0 ? "−" : ""; var v = Math.abs(n); return sg + (d.unidade === "pp" ? v.toLocaleString("pt-BR", { maximumFractionDigits: 2 }) + " pp" : moeda(v)); }
  function valorDif(d, v) { return d.unidade === "pp" ? pct(v) : moeda(v); }
  function comparacaoPedidosHtml(c) {
    if (!c) return "";
    var real = c.realizado, proj = c.projetado;
    var tres = '<div class="rg-precos">' +
      '<div class="vf-metric"><div class="vf-metric__label">Margem projetada (preço de hoje)</div><div class="vf-metric__value">' + (proj && !vazio(proj.margemPercent) ? pct(proj.margemPercent) : "—") + "</div>" + (proj && proj.limiteInferior ? '<div class="vf-metric__foot">limite inferior</div>' : "") + "</div>" +
      '<div class="vf-metric"><div class="vf-metric__label">Margem realizada (pedidos comprovados)</div><div class="vf-metric__value">' + (real ? pct(real.margemPercent) : "—") + "</div>" + (real ? '<div class="vf-metric__foot">' + inteiro(real.pedidos) + " pedido(s) · " + inteiro(real.unidades) + " un · " + moeda(real.faturamento) + "</div>" : "") + "</div>" +
      '<div class="vf-metric"><div class="vf-metric__label">Resultado realizado</div><div class="vf-metric__value">' + (real ? moeda(real.resultado) : "—") + "</div></div>" +
      '<div class="vf-metric"><div class="vf-metric__label">Preço médio vendido</div><div class="vf-metric__value">' + (real ? moeda(real.precoMedio) : "—") + "</div></div></div>";
    var dif = (c.diferencas || []).length ? '<table class="vf-table vf-table--compact rg-comparacao"><thead><tr><th>Por unidade</th><th class="rg-num">Projetado</th><th class="rg-num">Realizado</th><th class="rg-num">Diferença</th></tr></thead><tbody>' +
      c.diferencas.map(function (d) { return "<tr><td>" + esc(d.rotulo) + '</td><td class="rg-num">' + valorDif(d, d.projetado) + '</td><td class="rg-num">' + valorDif(d, d.realizado) + '</td><td class="rg-num"><strong>' + esc(sinalDiferenca(d)) + "</strong></td></tr>"; }).join("") + "</tbody></table>" : "";
    return '<section class="rg-secao"><h3 class="rg-h3">Projetado × realizado</h3>' + tres +
      '<p class="rg-sub">' + esc(c.conclusao || "") + (c.nota ? " " + esc(c.nota) : "") + "</p>" + dif +
      ((c.faltantes || []).length ? '<h4 class="rg-h3">Dados faltantes</h4><ul class="rg-lista">' + c.faltantes.map(function (f) { return "<li>" + esc(f) + "</li>"; }).join("") + "</ul>" : "") + "</section>";
  }
  function pedidosHtml(p, dias) {
    var lista = p.pedidos || [];
    var seletor = '<div class="vf-cluster rg-ped-topo"><label class="rg-sub" for="rg-ped-dias">Período</label><select class="vf-select vf-select--sm" id="rg-ped-dias">' +
      [30, 90, 180, 365].map(function (d) { return '<option value="' + d + '"' + (Number(dias) === d ? " selected" : "") + ">últimos " + d + " dias</option>"; }).join("") + "</select>" +
      '<span class="rg-sub">' + inteiro(lista.length) + " pedido(s) deste anúncio · fonte: Central de Vendas</span></div>";
    var tab = lista.length ? '<div class="vf-table-wrap"><table class="vf-table vf-table--compact rg-tabela-ped"><thead><tr><th>Data</th><th class="rg-num">Un.</th><th class="rg-num">Preço un.</th><th class="rg-num">Comissão</th><th class="rg-num">Frete</th><th class="rg-num">Resultado</th><th class="rg-num">Margem</th><th>Situação</th></tr></thead><tbody>' +
      lista.map(function (l) {
        return '<tr class="rg-linha" tabindex="0" data-rg-pedido="' + esc(l.rowId) + '"><td>' + esc(l.data || "—") + '<div class="rg-sub">' + esc(l.pedidoId || "") + '</div></td><td class="rg-num">' + inteiro(l.unidades) + '</td><td class="rg-num">' + moeda(l.precoUnitario) + '</td><td class="rg-num">' + moeda(l.comissao) + '</td><td class="rg-num">' + moeda(l.frete) + '</td><td class="rg-num">' + moeda(l.resultado) + '</td><td class="rg-num">' + (l.comprovado ? pct(l.margemRealizadaPercent) : "—") + "</td><td>" +
          (l.comprovado ? tag("Comprovado", "success") : tag("Sem comprovação", "neutral") + '<div class="rg-sub">' + esc(l.motivoNaoComprovado || "") + "</div>") + "</td></tr>"; }).join("") + "</tbody></table></div>" : '<p class="rg-sub">Nenhum pedido deste anúncio no período.</p>';
    return seletor + comparacaoPedidosHtml(p.comparacao) + '<section class="rg-secao"><h3 class="rg-h3">Pedidos</h3>' + tab + '<div id="rg-pedido-detalhe"></div></section>' +
      ((p.avisos || []).length ? '<ul class="rg-lista rg-sub">' + p.avisos.map(function (a) { return "<li>" + esc(a) + "</li>"; }).join("") + "</ul>" : "");
  }
  function detalhePedidoHtml(d) {
    var ped = d.pedido || {}, comp = d.componentes || [];
    var linhas = comp.map(function (c) {
      return "<tr><td>" + esc(c.rotulo) + (c.itemId ? "" : ' <span class="rg-sub">(do pedido)</span>') + '</td><td class="rg-num">' + esc(COMP_ROTULO_SINAL[c.efeito] || "") + " " + moeda(c.valor === null ? null : Math.abs(c.valor)) + "</td><td>" + (c.incluidoNoResultado === true ? "entra no resultado" : c.incluidoNoResultado === false ? "informativo" : "—") + "</td><td>" + esc(c.fonte || "—") + " " + esc(CONFIANCAS[c.confianca] || c.confianca || "") + "</td></tr>"; }).join("");
    var cf = d.conferencia;
    return '<div class="rg-ped-detalhe"><h4 class="rg-h3">Pedido ' + esc(ped.pedidoId) + " · " + esc(ped.data || "") + "</h4>" +
      '<div class="rg-precos"><div class="vf-metric"><div class="vf-metric__label">Preço vendido (un.)</div><div class="vf-metric__value">' + moeda(ped.precoUnitario) + '</div></div><div class="vf-metric"><div class="vf-metric__label">Quantidade</div><div class="vf-metric__value">' + inteiro(ped.unidades) + '</div></div><div class="vf-metric"><div class="vf-metric__label">Faturamento</div><div class="vf-metric__value">' + moeda(ped.valor) + '</div></div><div class="vf-metric"><div class="vf-metric__label">Resultado</div><div class="vf-metric__value">' + (ped.comprovado ? moeda(ped.resultado) : "não comprovado") + "</div>" + (ped.comprovado ? '<div class="vf-metric__foot">margem ' + pct(ped.margemRealizadaPercent) + "</div>" : "") + "</div></div>" +
      (ped.comprovado ? "" : '<p class="rg-sub"><strong>Resultado não comprovado:</strong> ' + esc(ped.motivoNaoComprovado || "") + "</p>") +
      (comp.length ? '<table class="vf-table vf-table--compact"><thead><tr><th>Componente</th><th class="rg-num">Valor</th><th>No resultado</th><th>Origem</th></tr></thead><tbody>' + linhas + "</tbody></table>" : '<p class="rg-sub">A Central de Vendas não tem componentes financeiros neste pedido.</p>') +
      (cf ? '<p class="rg-sub">Conferência: soma dos componentes ' + moeda(cf.somaComponentes) + " × resultado do pedido " + moeda(cf.resultadoPedido) + (cf.confere ? " — confere." : " — <strong>diferença de " + moeda(cf.diferenca) + "</strong>.") + "</p>" : "") +
      '<p class="rg-sub">Compensações: receita de envio ' + moeda(d.compensacoes && d.compensacoes.receitaEnvio) + " · reembolso " + moeda(d.compensacoes && d.compensacoes.reembolso) + ". " + esc(d.compensacoes && d.compensacoes.observacao || "") + " Descontos e bônus do ML: " + esc(d.compensacoes && d.compensacoes.descontosEBonusDoMl || "—") + "</p>" +
      (d.posVenda ? '<p class="rg-sub">Pós-venda: ' + esc(d.posVenda.tipo) + (d.posVenda.motivo ? " — " + esc(d.posVenda.motivo) : "") + "</p>" : "") +
      ((d.dadosFaltantes || []).length ? '<h4 class="rg-h3">Dados faltantes</h4><ul class="rg-lista">' + d.dadosFaltantes.map(function (f) { return "<li>" + esc(f) + "</li>"; }).join("") + "</ul>" : "") + "</div>";
  }

  /** Antes × depois de uma simulação (o "depois" vem do servidor, recotado no preço). */
  function comparacaoHtml(b, sim) {
    var r = sim && sim.resultado || {};
    var antes = b.resultado || {};
    var linha = function (rotulo, a, d) { return "<tr><td>" + esc(rotulo) + '</td><td class="rg-num">' + a + '</td><td class="rg-num"><strong>' + d + "</strong></td></tr>"; };
    var c = function (k) { var l = (b.cascata || []).filter(function (x) { return x.chave === k; })[0]; return l ? l.valor : null; };
    return '<table class="vf-table vf-table--compact rg-comparacao"><thead><tr><th></th><th class="rg-num">Agora</th><th class="rg-num">Simulado</th></tr></thead><tbody>' +
      linha("Comprador paga", moeda(b.precos && b.precos.comprador), moeda(sim.preco)) +
      linha("Subsídio do ML", moeda(c("subsidioMl")), '<span class="rg-sub">não se transfere</span>') +
      linha("Comissão", moeda(c("comissao")), moeda(sim.comissao && sim.comissao.valor)) +
      linha("Frete", moeda(c("frete")), moeda(sim.frete && sim.frete.valor)) +
      linha("Lucro /un", moeda(antes.lucro), moeda(r.lucro)) +
      linha("Margem", pct(antes.margemPercent), pct(r.margemPercent)) +
      "</tbody></table>" + ((sim.bloqueios || []).length ? '<p class="rg-sub">' + esc(sim.bloqueios.map(function (x) { return x.texto; }).join(" ")) + "</p>" : "") +
      '<p class="rg-sub">Comissão e frete cotados no preço simulado (faixa de preço e modalidade incluídas). Preço novo não herda o subsídio da promoção atual.</p>';
  }

  function promocoesDisponiveisHtml(lista, ctx, cfg) {
    if (!lista || !lista.length) return '<p class="rg-sub">Nenhuma promoção retornada pelo Mercado Livre.</p>';
    var habilitadas = podeAgir(ctx, cfg);
    return '<ul class="rg-promos">' + lista.map(function (p, i) {
      var vr = p.voceRecebe || {};
      var ativa = p.status === "started" || p.status === "active";
      var pode = ativa ? (p.modoEscrita ? "SAIR_DA_PROMOCAO" : null) : (p.status === "candidate" && p.modoEscrita === "ACEITE" ? "PARTICIPAR" : null);
      return '<li class="rg-promos__item"><div><strong>' + esc(p.tipoLabel || p.tipo) + "</strong>" + (p.nome ? " · " + esc(p.nome) : "") + " " + tag(p.statusExibicao || p.statusLabel || p.status || "—", ativa ? "primary" : "neutral") +
        '<div class="rg-sub">Comprador pagaria ' + moeda(p.precoFinal) + (vazio(p.meliPercentage) ? "" : " · ML " + pct(p.meliPercentage)) + (vazio(p.subsidioMl) ? "" : " (" + moeda(p.subsidioMl) + "/un)") +
        " · margem nela " + (vr.computable ? pct(vr.marginPercent) : "não calculável") + "</div></div>" +
        (pode ? '<button class="vf-btn vf-btn--ghost vf-btn--sm" type="button" data-rg-promo="' + i + '" data-rg-promo-acao="' + pode + '"' + (habilitadas ? "" : " disabled") + ">" + esc(ACAO_ROTULO[pode]) + "</button>" : "") + "</li>";
    }).join("") + "</ul>";
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
      : (b.sugerido && b.sugerido.status === "RECOTADO" && Math.abs(Number(b.sugerido.preco) - Number(acao.precoAlvo)) < 0.005 ? pct(b.sugerido.margemPercent) : "não recotada");
    return "<p><strong>" + esc(acao.rotulo || ACAO_ROTULO[acao.tipo]) + "</strong></p>" +
      '<table class="vf-table vf-table--compact"><thead><tr><th></th><th class="rg-num">Agora (relido)</th><th class="rg-num">Depois</th></tr></thead><tbody>' +
      '<tr><td>Comprador paga</td><td class="rg-num">' + moeda(relido && relido.precoAtual) + '</td><td class="rg-num"><strong>' + depois + "</strong></td></tr>" +
      '<tr><td>Margem</td><td class="rg-num">' + pct(b.resultado && b.resultado.margemPercent) + '</td><td class="rg-num"><strong>' + margemDepois + "</strong></td></tr></tbody></table>" +
      (conferencia.ok ? '<p class="rg-sub">Será enviado pelo endpoint existente de Anúncios ML (' + esc(acao.endpoint || "") + "), com as mesmas travas da tela de Anúncios.</p>" +
        '<label class="vf-check"><input type="checkbox" id="rg-modal-ciente"> Revisei os valores e quero enviar esta alteração ao Mercado Livre.</label>'
        : '<div class="vf-banner vf-banner--compact"><div class="vf-banner__content"><div class="vf-banner__title">Ação bloqueada</div><div class="vf-banner__description">' + esc(conferencia.motivo) + "</div></div></div>");
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

  // ── Estado e telas ──────────────────────────────────────────────────────
  var estado = { cfg: { acoesHabilitadas: false, preview: false, recotacaoSobDemanda: false }, global: null, contaId: null, meta: 15, filtro: "", recentes: false, busca: "", pagina: 1, limite: 50, aberto: null, promocoes: null, pedidos: null, abaBancada: "margem", pedidosDias: 90, acaoPendente: null };
  function $(id) { return root.document.getElementById(id); }
  function mostrarEstado(html) { $("rg-estado").innerHTML = html || ""; }
  function toast(msg, tom) { var el = root.document.createElement("div"); el.className = "vf-toast"; el.innerHTML = '<div class="vf-toast__content"><div class="vf-toast__title">' + esc(msg) + "</div></div>"; if (tom) el.dataset.tone = tom; $("rg-toasts").appendChild(el); setTimeout(function () { el.remove(); }, 6000); }
  function atualizarHash() {
    var h = buildQuery({ conta: estado.contaId, filtro: estado.filtro, item: estado.aberto && estado.aberto.item && estado.aberto.item.itemId }).replace(/^\?/, "");
    try { root.history.replaceState(null, "", h ? "#" + h : "#"); } catch (_) { /* sem history */ }
  }
  function trocarAba(aba) {
    Array.prototype.forEach.call(root.document.querySelectorAll("[data-rg-tab]"), function (b) { var on = b.dataset.rgTab === aba; b.setAttribute("aria-selected", String(on)); b.classList.toggle("is-active", on); });
    Array.prototype.forEach.call(root.document.querySelectorAll("[data-rg-painel]"), function (p) { p.hidden = p.dataset.rgPainel !== aba; });
  }

  function renderModo() {
    var cfg = estado.cfg, el = $("rg-modo");
    var txt = cfg.preview ? "Preview local — somente leitura: simular, recotar e ações no Mercado Livre estão desligados." : !cfg.acoesHabilitadas ? "Ações no Mercado Livre desligadas neste ambiente. Você pode analisar, simular e revisar." : "";
    el.hidden = !txt; el.innerHTML = txt ? '<div class="vf-banner vf-banner--compact"><div class="vf-banner__content"><div class="vf-banner__description">' + esc(txt) + "</div></div></div>" : "";
  }

  function renderContas(d) {
    var contas = (d.contas || []).filter(function (c) { return !c.semAvaliacao; });
    contas.sort(function (a, b) { return (Number(b.precisamRevisao) || 0) - (Number(a.precisamRevisao) || 0) || String(a.clienteNome).localeCompare(String(b.clienteNome)); });
    $("rg-conta").innerHTML = contas.map(function (c) { return '<option value="' + esc(c.clienteContaId) + '">' + esc((c.clienteNome || "Cliente") + (c.contaNome ? " — " + c.contaNome : "")) + " (" + inteiro(c.itens) + ")</option>"; }).join("");
    if (!contas.length) $("rg-estado").innerHTML = '<div class="vf-banner vf-banner--compact"><div class="vf-banner__content"><div class="vf-banner__description">Nenhuma conta com auditoria nesta origem de dados. No preview local, confira a pasta passada em --dados.</div></div></div>';
    $("rg-exec").textContent = d.execucao ? "Auditoria de " + data(d.execucao.finalizadaEm || d.execucao.iniciadaEm) : "Nenhuma auditoria concluída";
    var t = d.totais || {};
    $("rg-kpis").innerHTML = d.execucao ? [["Contas avaliadas", inteiro(t.contasAvaliadas)], ["Sem avaliação", inteiro(t.contasSemAvaliacao)], ["Anúncios auditados", inteiro(t.anunciosAuditados)], ["Alterados recentemente", inteiro(t.alteradosRecentemente)]]
      .map(function (k) { return '<div class="vf-kpi"><div class="vf-kpi__label">' + esc(k[0]) + '</div><div class="vf-kpi__value">' + k[1] + "</div></div>"; }).join("") : "";
    $("rg-contas").innerHTML = (d.contas || []).map(function (c) {
      if (c.semAvaliacao) return '<tr class="rg-linha--muda"><td>' + esc(c.clienteNome || "—") + ' <span class="rg-sub">' + esc(c.contaNome || "") + '</span></td><td colspan="5">' + tag("Sem avaliação", "neutral") + " " + esc(c.semAvaliacao) + "</td></tr>";
      return '<tr class="rg-linha" tabindex="0" data-rg-conta="' + esc(c.clienteContaId) + '"><td>' + esc(c.clienteNome || "—") + ' <span class="rg-sub">' + esc(c.contaNome || "") + '</span></td><td class="rg-num">' + inteiro(c.itens) + '</td><td class="rg-num">' + inteiro(c.precisamRevisao) + '</td><td class="rg-num">' + inteiro(c.semMargemConfiavel) + '</td><td class="rg-num">' + inteiro(c.alteradosRecentemente) + "</td><td>" + esc(c.matriz && c.matriz.decisao || c.decisaoAtivacao || "—") + "</td></tr>";
    }).join("");
    var a = d.ativacao;
    $("rg-ativacao").innerHTML = a ? '<section class="rg-secao"><h3 class="rg-h3">Ativação do cotador por ondas</h3>' + (a.envProposto ? Object.keys(a.envProposto).map(function (k) { return "<div><code>" + esc(k) + "=" + esc(a.envProposto[k]) + "</code></div>"; }).join("") : '<p class="rg-sub">Nenhuma conta pronta para a próxima onda.</p>') + '<ol class="rg-lista">' + (a.passos || []).map(function (p) { return "<li>" + esc(p) + "</li>"; }).join("") + "</ol></section>" : "";
  }

  function renderResumoConta() {
    var c = ((estado.global && estado.global.contas) || []).filter(function (x) { return Number(x.clienteContaId) === estado.contaId; })[0] || {};
    var bc = c.bancada;
    $("rg-conta-resumo").innerHTML = '<span class="rg-sub">' + inteiro(c.itens) + " anúncios · seller " + esc(c.sellerId || "—") + (bc ? " · evidência de promoção em " + inteiro(bc.comFinanciamento) + " · recotados " + inteiro(bc.comRecotacao) : "") + "</span>";
    $("rg-xlsx-conta").href = apiBase() + "/resgate/contas/" + estado.contaId + "/plano.xlsx";
  }

  function consultaLista(extra) { return buildQuery(Object.assign({ meta: estado.meta, recentes: estado.recentes, busca: estado.busca }, extra || {})); }
  function carregarContagens() {
    var base = "/resgate/contas/" + estado.contaId + "/itens";
    ["", "abaixo_meta", "prejuizo", "desconhecida", "promocao"].forEach(function (f) {
      var el = root.document.querySelector('[data-rg-cont="' + f + '"]'); if (el) el.textContent = "";
      chamar(base + consultaLista({ filtro: f, limite: 1 })).then(function (r) { if (el && r.ok) el.textContent = inteiro(r.data.total); });
    });
  }
  function carregarItens() {
    $("rg-itens").innerHTML = '<tr><td colspan="6" class="vf-table__loading">Carregando…</td></tr>';
    return chamar("/resgate/contas/" + estado.contaId + "/itens" + consultaLista({ filtro: estado.filtro, pagina: estado.pagina, limite: estado.limite })).then(function (r) {
      if (!r.ok) { $("rg-itens").innerHTML = '<tr><td colspan="6" class="vf-table__empty">' + esc(r.data && r.data.motivo || "Erro.") + "</td></tr>"; return; }
      $("rg-itens").innerHTML = r.data.itens.map(linhaItem).join("") || '<tr><td colspan="6" class="vf-table__empty">Nenhum anúncio com estes filtros.</td></tr>';
      var paginas = Math.max(1, Math.ceil(r.data.total / estado.limite));
      $("rg-paginacao").innerHTML = '<div class="vf-pagination__info">' + inteiro(r.data.total) + " anúncios · página " + estado.pagina + " de " + paginas + '</div><div class="vf-pagination__actions"><button class="vf-btn vf-btn--ghost vf-btn--sm" type="button" data-rg-pag="-1"' + (estado.pagina <= 1 ? " disabled" : "") + '>Anterior</button><button class="vf-btn vf-btn--ghost vf-btn--sm" type="button" data-rg-pag="1"' + (estado.pagina >= paginas ? " disabled" : "") + ">Próxima</button></div>";
    });
  }
  function recarregarLista() { estado.pagina = 1; carregarContagens(); atualizarHash(); return carregarItens(); }
  function abrirConta(id) {
    estado.contaId = Number(id); $("rg-conta").value = String(estado.contaId); trocarAba("anuncios"); renderResumoConta();
    return recarregarLista();
  }
  function marcarFiltro(f) {
    estado.filtro = f || "";
    Array.prototype.forEach.call(root.document.querySelectorAll("[data-rg-filtro]"), function (b) { var on = b.dataset.rgFiltro === estado.filtro; b.classList.toggle("is-active", on); b.setAttribute("aria-pressed", String(on)); });
  }

  function renderBancada(extra) {
    var det = estado.aberto; if (!det) return;
    $("rg-drawer-title").textContent = det.item.itemId;
    $("rg-drawer-sub").textContent = (det.item.titulo || "") + (det.item.sku ? " · SKU " + det.item.sku : "");
    $("rg-drawer-corpo").innerHTML = bancadaHtml(det, estado.cfg, Object.assign({ aba: estado.abaBancada }, extra || {}));
    if (estado.pedidos) $("rg-pedidos").innerHTML = estado.pedidos.html;
    if (estado.promocoes) $("rg-promocoes").innerHTML = promocoesDisponiveisHtml(estado.promocoes, det.contexto, estado.cfg);
  }
  function abrirItem(itemId) {
    $("rg-drawer").hidden = false; $("rg-drawer-backdrop").hidden = false;
    $("rg-drawer").classList.add("is-open"); $("rg-drawer-backdrop").classList.add("is-open");
    $("rg-drawer-title").textContent = itemId; $("rg-drawer-corpo").innerHTML = '<div class="vf-loading-state"><span class="vf-spinner vf-spinner--sm"></span></div>';
    estado.promocoes = null; estado.pedidos = null; estado.abaBancada = "margem";
    return chamar("/resgate/contas/" + estado.contaId + "/itens/" + encodeURIComponent(itemId) + buildQuery({ meta: estado.meta })).then(function (r) {
      if (!r.ok) { $("rg-drawer-corpo").innerHTML = esc(r.data && r.data.motivo || "Erro."); return; }
      estado.aberto = r.data; atualizarHash(); renderBancada();
    });
  }
  function fecharItem() {
    $("rg-drawer").classList.remove("is-open"); $("rg-drawer-backdrop").classList.remove("is-open");
    $("rg-drawer").hidden = true; $("rg-drawer-backdrop").hidden = true; estado.aberto = null; atualizarHash();
  }

  function urlItem(sufixo) { return "/resgate/contas/" + estado.contaId + "/itens/" + encodeURIComponent(estado.aberto.item.itemId) + (sufixo || ""); }
  function recotar() {
    if (!estado.aberto || !estado.cfg.recotacaoSobDemanda) return null;
    toast("Recotando no Mercado Livre (somente leitura)…", "info");
    return chamar(urlItem("/simular"), { method: "POST", body: { meta: estado.meta } }).then(function (r) {
      if (!r.ok) { toast((r.data && r.data.motivo) || "Não foi possível recotar.", "danger"); return; }
      estado.aberto = Object.assign({}, estado.aberto, { bancada: r.data.bancada });
      renderBancada({ aoVivo: r.data.observadoEm });
    });
  }
  function simular() {
    var p = lerNumero($("rg-sim-preco").value);
    if (!estado.aberto || p === null || !estado.cfg.recotacaoSobDemanda) { if (p === null) toast("Informe um preço válido.", "warning"); return null; }
    $("rg-sim-saida").innerHTML = '<div class="vf-loading-state"><span class="vf-spinner vf-spinner--sm"></span> Cotando comissão e frete no preço simulado…</div>';
    return chamar(urlItem("/simular"), { method: "POST", body: { precos: [p], meta: estado.meta, recotar: false } }).then(function (r) {
      if (!r.ok) { $("rg-sim-saida").innerHTML = '<p class="rg-sub">' + esc(r.data && r.data.motivo || "Erro ao simular.") + "</p>"; return; }
      var s = (r.data.simulacoes || [])[0];
      $("rg-sim-saida").innerHTML = s ? comparacaoHtml(r.data.bancada || estado.aberto.bancada, s) : '<p class="rg-sub">Sem resultado.</p>';
    });
  }
  function trocarAbaBancada(aba) {
    estado.abaBancada = aba;
    Array.prototype.forEach.call(root.document.querySelectorAll("[data-rg-baba]"), function (b) { var on = b.dataset.rgBaba === aba; b.classList.toggle("is-active", on); b.setAttribute("aria-selected", String(on)); });
    Array.prototype.forEach.call(root.document.querySelectorAll("[data-rg-bpainel]"), function (p) { p.hidden = p.dataset.rgBpainel !== aba; });
    if (aba === "pedidos" && !estado.pedidos) carregarPedidos();
  }
  function carregarPedidos() {
    if (!estado.aberto) return null;
    var itemId = estado.aberto.item.itemId;
    $("rg-pedidos").innerHTML = '<div class="vf-loading-state"><span class="vf-spinner vf-spinner--sm"></span> Lendo pedidos na Central de Vendas…</div>';
    return chamar(urlItem("/pedidos") + buildQuery({ dias: estado.pedidosDias, meta: estado.meta })).then(function (r) {
      if (!estado.aberto || estado.aberto.item.itemId !== itemId) return;
      if (!r.ok) { $("rg-pedidos").innerHTML = '<p class="rg-sub">' + esc(MOTIVO_ERRO_PEDIDOS[r.status] || (r.data && r.data.motivo) || "Não foi possível ler os pedidos.") + "</p>"; return; }
      estado.pedidos = { dados: r.data, html: pedidosHtml(r.data, estado.pedidosDias) };
      $("rg-pedidos").innerHTML = estado.pedidos.html;
    });
  }
  function abrirPedido(rowId) {
    if (!estado.aberto) return null;
    var el = $("rg-pedido-detalhe"); if (!el) return null;
    el.innerHTML = '<div class="vf-loading-state"><span class="vf-spinner vf-spinner--sm"></span></div>';
    return chamar(urlItem("/pedidos/" + encodeURIComponent(rowId)) + buildQuery({ dias: estado.pedidosDias, meta: estado.meta })).then(function (r) {
      el.innerHTML = r.ok ? detalhePedidoHtml(r.data) : '<p class="rg-sub">' + esc(MOTIVO_ERRO_PEDIDOS[r.status] || (r.data && r.data.motivo) || "Não foi possível ler o pedido.") + "</p>";
      if (r.ok && el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
    });
  }
  function verPromocoes() {
    var ctx = estado.aberto && estado.aberto.contexto; if (!ctx || !ctx.clienteSlug || ctx.preview) return null;
    $("rg-promocoes").innerHTML = '<div class="vf-loading-state"><span class="vf-spinner vf-spinner--sm"></span> Lendo promoções…</div>';
    return chamar("/anuncios-meli/" + encodeURIComponent(estado.aberto.item.itemId) + "/promocoes" + buildQuery({ clienteSlug: ctx.clienteSlug, clienteContaId: ctx.clienteContaId })).then(function (r) {
      if (!r.ok) { $("rg-promocoes").innerHTML = '<p class="rg-sub">' + esc(r.data && r.data.motivo || "Erro ao ler promoções.") + "</p>"; return; }
      estado.promocoes = r.data.promocoes || [];
      $("rg-promocoes").innerHTML = promocoesDisponiveisHtml(estado.promocoes, ctx, estado.cfg);
    });
  }
  function revisar(status) {
    var x = estado.aberto && estado.aberto.item; if (!x) return null;
    return chamar(urlItem("/revisao"), { method: "POST", body: { status: status, precoVisto: x.fingerprint && x.fingerprint.precoVisto } }).then(function (r) {
      toast(r.ok ? "Revisão registrada: " + ((REVISAO[status] || [status])[0]) : (r.data && r.data.motivo) || "Erro ao revisar.", r.ok ? "success" : "danger");
      if (r.ok) { estado.aberto.item.revisao = { status: status, em: new Date().toISOString() }; renderBancada(); }
    });
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
        .then(function () { return abrirItem(det.item.itemId); }).then(function () { return r; });
    });
  }

  function iniciar() {
    if (!root.document || !$("rg-app")) return;
    var metaSalva = Number(lerPreferencia("vf-resgate-meta", "15"));
    estado.meta = isFinite(metaSalva) && metaSalva >= 0 && metaSalva < 90 ? metaSalva : 15;
    $("rg-meta").value = String(estado.meta);
    root.document.addEventListener("click", function (ev) {
      var t = ev.target.closest && ev.target.closest("[data-rg-tab],[data-rg-baba],[data-rg-pedido],[data-rg-conta],[data-rg-item],[data-rg-pag],[data-rg-filtro],[data-rg-revisar],[data-rg-acao],[data-rg-recotar],[data-rg-ver-promocoes],[data-rg-promo],#rg-drawer-fechar,#rg-drawer-backdrop,#rg-sim-ir,#rg-modal-cancelar,#rg-modal-confirmar");
      if (!t || t.disabled) return;
      if (t.dataset.rgTab) trocarAba(t.dataset.rgTab);
      else if (t.dataset.rgBaba) trocarAbaBancada(t.dataset.rgBaba);
      else if (t.dataset.rgPedido !== undefined) abrirPedido(t.dataset.rgPedido);
      else if (t.dataset.rgConta) abrirConta(t.dataset.rgConta);
      else if (t.dataset.rgItem) abrirItem(t.dataset.rgItem);
      else if (t.dataset.rgPag) { estado.pagina += Number(t.dataset.rgPag); carregarItens(); }
      else if (t.dataset.rgFiltro !== undefined) { marcarFiltro(t.dataset.rgFiltro); estado.pagina = 1; atualizarHash(); carregarItens(); }
      else if (t.dataset.rgRevisar) revisar(t.dataset.rgRevisar);
      else if (t.dataset.rgAcao !== undefined) prepararAcao(estado.aberto && estado.aberto.bancada.acoes[Number(t.dataset.rgAcao)]);
      else if (t.dataset.rgPromo !== undefined) { var p = estado.promocoes && estado.promocoes[Number(t.dataset.rgPromo)]; if (p) prepararAcao({ tipo: t.dataset.rgPromoAcao, rotulo: ACAO_ROTULO[t.dataset.rgPromoAcao] + ": " + (p.tipoLabel || p.tipo), promocaoId: p.id, promocaoTipo: p.tipo, suportada: Boolean(p.modoEscrita), endpoint: "POST /anuncios-meli/:itemId/promocoes/:promotionId/" + (t.dataset.rgPromoAcao === "PARTICIPAR" ? "participar" : "sair"), resultadoEsperado: { precoComprador: p.precoFinal, recotado: false } }); }
      else if (t.hasAttribute("data-rg-recotar")) recotar();
      else if (t.hasAttribute("data-rg-ver-promocoes")) verPromocoes();
      else if (t.id === "rg-sim-ir") simular();
      else if (t.id === "rg-modal-cancelar") fecharModal();
      else if (t.id === "rg-modal-confirmar") executarAcao();
      else fecharItem();
    });
    root.document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape") { if ($("rg-modal").classList.contains("is-open")) fecharModal(); else fecharItem(); }
      if (ev.key === "Enter" && ev.target.dataset && (ev.target.dataset.rgConta || ev.target.dataset.rgItem)) ev.target.click();
    });
    root.document.addEventListener("change", function (ev) { if (ev.target && ev.target.id === "rg-ped-dias") { estado.pedidosDias = Number(ev.target.value) || 90; estado.pedidos = null; carregarPedidos(); } });
    $("rg-conta").addEventListener("change", function () { abrirConta(this.value); });
    $("rg-meta").addEventListener("change", function () {
      var n = lerNumero(this.value); if (n === null || n >= 90) { this.value = String(estado.meta); return; }
      estado.meta = n; gravarPreferencia("vf-resgate-meta", String(n)); recarregarLista(); if (estado.aberto) abrirItem(estado.aberto.item.itemId);
    });
    $("rg-f-recentes").addEventListener("change", function () { estado.recentes = this.checked; recarregarLista(); });
    var timer = null; $("rg-f-busca").addEventListener("input", function () { var v = this.value.trim(); clearTimeout(timer); timer = setTimeout(function () { estado.busca = v; recarregarLista(); }, 350); });
    $("rg-xlsx-conta").addEventListener("click", function (ev) {
      ev.preventDefault();
      root.fetch(this.href, { headers: { Authorization: "Bearer " + token() } }).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.blob(); })
        .then(function (b) { var a = root.document.createElement("a"); a.href = URL.createObjectURL(b); a.download = "venforce-resgate-conta-" + estado.contaId + ".xlsx"; a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000); })
        .catch(function (e) { toast("Erro ao baixar: " + e.message, "danger"); });
    });
    mostrarEstado('<div class="vf-loading-state"><span class="vf-spinner vf-spinner--sm"></span> Lendo a última auditoria…</div>');
    chamar("/resgate/config").then(function (c) {
      if (c.ok) estado.cfg = { acoesHabilitadas: Boolean(c.data.acoesHabilitadas), preview: Boolean(c.data.preview), recotacaoSobDemanda: Boolean(c.data.recotacaoSobDemanda) };
      renderModo();
      return chamar("/resgate/visao-global");
    }).then(function (r) {
      if (!r.ok) { mostrarEstado('<div class="vf-banner"><div class="vf-banner__content"><div class="vf-banner__title">Resgate indisponível</div><div class="vf-banner__description">' + esc(r.data && r.data.motivo || "Erro ao carregar.") + "</div></div></div>"); return; }
      mostrarEstado(""); estado.global = r.data; renderContas(r.data);
      var h = new URLSearchParams(String(root.location && root.location.hash || "").replace(/^#/, ""));
      marcarFiltro(h.get("filtro") || "");
      var conta = h.get("conta") || $("rg-conta").value;
      if (!conta) { mostrarEstado('<div class="vf-empty"><div class="vf-empty__title">Nenhuma conta auditada na sua carteira.</div></div>'); return; }
      abrirConta(conta).then(function () { if (h.get("item")) abrirItem(h.get("item")).then(function () { if (h.get("aba") === "pedidos") trocarAbaBancada("pedidos"); }); });
    });
  }

  return {
    iniciar: iniciar, moeda: moeda, pct: pct, inteiro: inteiro, esc: esc, buildQuery: buildQuery, lerNumero: lerNumero, lerPrecos: lerPrecos,
    linhaItem: linhaItem, bancadaHtml: bancadaHtml, pedidosHtml: pedidosHtml, detalhePedidoHtml: detalhePedidoHtml, comparacaoPedidosHtml: comparacaoPedidosHtml, cascataHtml: cascataHtml, comparacaoHtml: comparacaoHtml, promocoesDisponiveisHtml: promocoesDisponiveisHtml,
    acoesHtml: acoesHtml, planoDaAcao: planoDaAcao, conferirReleitura: conferirReleitura, podeAgir: podeAgir, modalHtml: modalHtml,
    _estado: estado, _prepararAcao: prepararAcao, _executarAcao: executarAcao, STATUS: STATUS,
  };
});
