/*
 * VenForce Resgate — tela. Só LÊ o que o backend calculou (contrato
 * resgate-contrato/1): nenhuma fórmula financeira aqui, nenhum valor ausente
 * vira 0 (ausente = "—"). Únicas chamadas que tocam o ML: "Simular ao vivo" e
 * "Dry-run" — ambas GET no backend. Não existe botão que altere preço.
 */
(function (root, factory) {
  var api = factory(root || {});
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.VFResgate = api; if (root.document) root.document.addEventListener("DOMContentLoaded", function () { api.iniciar(); }); }
})(typeof window !== "undefined" ? window : globalThis, function (root) {
  "use strict";

  var DEFAULT_API_BASE = "https://venforce-server.onrender.com";
  var SITUACOES = {
    MARGEM_ANTIGA_INFLADA: ["Margem antiga inflada", "danger"], PREJUIZO: ["Prejuízo", "danger"], ABAIXO_DA_META: ["Abaixo da meta", "warning"],
    DADOS_INSUFICIENTES: ["Dados insuficientes", "neutral"], MARGEM_DESCONHECIDA: ["Margem desconhecida", "neutral"],
    SNAPSHOT_DESATUALIZADO: ["Snapshot desatualizado", "info"], PROMOCAO_SUBSIDIADA: ["Promoção subsidiada", "success"], PRECO_OK: ["Preço correto", "success"],
  };
  var ACOES = { REVISAR_PRECO: "Revisar preço", COMPLETAR_DADOS: "Completar dados", VERIFICAR_FRETE: "Verificar frete", VERIFICAR_SUBSIDIO: "Verificar subsídio", RECALCULAR_SNAPSHOT: "Recalcular", NENHUMA: "Nenhuma" };
  var ORIGENS = { SEM_ALTERACAO_REGISTRADA: "Sem alteração registrada", ALTERADO_MANUAL: "Alterado manualmente", ALTERADO_AUTOMACAO: "Alterado por automação", ALTERADO_ORIGEM_INDETERMINADA: "Alterado (origem indeterminada)", HISTORICO_INSUFICIENTE: "Histórico insuficiente" };
  var DECISOES = { JA_LIBERADA: ["Liberada", "success"], LIBERAR_PRIORITARIO: ["Liberar com prioridade", "danger"], LIBERAVEL: ["Pode liberar", "primary"], LIBERAVEL_COM_RESSALVAS: ["Liberar c/ ressalvas", "warning"], NAO_LIBERAVEL: ["Não liberar", "danger"], SEM_DADOS: ["Sem dados", "neutral"] };
  var CONFIANCAS = { alta: "alta", media: "média", baixa: "baixa", nao_verificada: "não verificada", desconhecida: "desconhecida" };

  // ── Formatação (ausente = "—", nunca 0) ─────────────────────────────────
  function vazio(v) { return v === null || v === undefined || v === "" || (typeof v === "number" && !isFinite(v)); }
  function moeda(v) { return vazio(v) ? "—" : "R$ " + Number(v).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function pct(v) { return vazio(v) ? "—" : Number(v).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + "%"; }
  function inteiro(v) { return vazio(v) ? "—" : Number(v).toLocaleString("pt-BR"); }
  function data(v) { if (vazio(v)) return "—"; var d = new Date(v); return isNaN(d.getTime()) ? "—" : d.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }); }
  function esc(s) { return String(s === null || s === undefined ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function tag(texto, tom) { return '<span class="vf-tag is-' + esc(tom || "neutral") + '">' + esc(texto) + "</span>"; }
  function situacaoTag(s) { var x = SITUACOES[s] || [s || "—", "neutral"]; return tag(x[0], x[1]); }
  function decisaoTag(d) { var x = DECISOES[d] || [d || "—", "neutral"]; return tag(x[0], x[1]); }

  function buildQuery(params) {
    var q = new URLSearchParams();
    Object.keys(params || {}).forEach(function (k) { var v = params[k]; if (v === null || v === undefined || v === "" || v === false) return; q.set(k, v === true ? "1" : String(v)); });
    var s = q.toString();
    return s ? "?" + s : "";
  }

  // ── Linhas (puras, testáveis) ─────────────────────────────────────────────
  function linhaConta(c) {
    var nome = esc(c.clienteNome || "—") + (c.contaNome ? ' <span class="rg-sub">' + esc(c.contaNome) + "</span>" : "");
    if (c.semAvaliacao) {
      return '<tr class="rg-linha rg-linha--muda"><td>' + nome + "</td><td>" + esc(c.sellerId || "—") + '</td><td colspan="8">' + tag("Sem avaliação", "neutral") + " " + esc(c.semAvaliacao) + "</td></tr>";
    }
    var m = c.matriz || {};
    return '<tr class="rg-linha" tabindex="0" data-rg-conta="' + esc(c.clienteContaId) + '"><td>' + nome + "</td><td>" + esc(c.sellerId || "—") + '</td><td class="rg-num">' + inteiro(c.itens) +
      '</td><td class="rg-num">' + inteiro(c.precosCorretos) + '</td><td class="rg-num"><strong>' + inteiro(c.precisamRevisao) + '</strong></td><td class="rg-num">' + inteiro(c.semMargemConfiavel) +
      '</td><td class="rg-num">' + inteiro(c.alteradosRecentemente) + '</td><td class="rg-num">' + moeda(c.riscoFinanceiro30d) + "</td><td>" + decisaoTag(m.decisao || c.decisaoAtivacao) + "</td><td>" +
      (c.financeiramenteValidada ? tag("Sim", "success") : tag("Não", "neutral")) + "</td></tr>";
  }

  function linhaItem(x) {
    var rec = x.recomendacao;
    var proposta = rec && rec.ok ? moeda(rec.preco) + ' <span class="rg-sub">→ ' + pct(rec.margemPercentApos) + "</span>" : rec ? '<span class="rg-sub">' + esc(rec.motivo || "—") + "</span>" : "—";
    var rev = x.revisao && x.revisao.status ? x.revisao.status : "PENDENTE";
    var exp = x.exposicao && !vazio(x.exposicao.valor) ? (x.exposicao.tipo === "faturamento_exposto" ? '<span class="rg-sub" title="Faturamento com margem desconhecida">fat. </span>' : "") + moeda(x.exposicao.valor) : "—";
    return '<tr class="rg-linha" tabindex="0" data-rg-item="' + esc(x.itemId) + '"><td><div class="rg-anuncio"><strong>' + esc(x.itemId) + '</strong><span class="rg-sub vf-truncate">' + esc(x.titulo || "") + "</span></div></td>" +
      '<td class="rg-num">' + moeda(x.preco) + '</td><td class="rg-num">' + pct(x.margemPercent) + '</td><td class="rg-num">' + pct(x.margemExibida) + "</td>" +
      "<td>" + moeda(x.frete) + ' <span class="rg-sub">' + esc(CONFIANCAS[x.confianca] || x.freteNivel || "") + "</span></td>" +
      "<td>" + situacaoTag(x.situacao) + "</td><td>" + esc(ORIGENS[x.origem] || x.origem || "—") + (x.mudancaRecente ? " " + tag("recente", "warning") : "") + "</td>" +
      '<td class="rg-num">' + inteiro(x.unidades30d) + '</td><td class="rg-num">' + exp + "</td><td>" + proposta + "</td><td>" + esc(rev) + "</td></tr>";
  }

  function blocoComponentes(contrato) {
    var c = (contrato && contrato.componentes) || {};
    var linhas = [["Preço cheio", c.precoCheio, moeda], ["Preço vigente", c.precoVigente, moeda], ["Preço promocional", c.precoPromocional, moeda], ["Subsídio ML /un", c.subsidioMl, moeda],
      ["Valor reconhecido", c.valorReconhecidoVendedor, moeda], ["Desconto do vendedor", c.descontoVendedor, moeda], ["Comissão", c.comissao, moeda], ["Frete", c.frete, moeda],
      ["Custo", c.custo, moeda], ["Imposto", c.imposto, function (v) { return vazio(v) ? "—" : pct(v * 100); }], ["Taxa fixa", c.taxaFixa, moeda]];
    return '<table class="vf-table vf-table--compact rg-componentes"><thead><tr><th>Componente</th><th class="rg-num">Valor</th><th>Fonte</th><th>Confiança</th><th>Evidência</th></tr></thead><tbody>' +
      linhas.map(function (l) { var x = l[1] || {}; return "<tr><td>" + esc(l[0]) + '</td><td class="rg-num">' + l[2](x.valor) + "</td><td>" + esc(x.fonte || "—") + "</td><td>" + esc(CONFIANCAS[x.confianca] || x.confianca || "—") + "</td><td>" + data(x.observadoEm) + "</td></tr>"; }).join("") +
      "</tbody></table>";
  }

  function detalheItem(x) {
    var c = x.contrato || {}, r = c.resultado || {};
    var lista = function (arr, campo) { return arr && arr.length ? "<ul class=\"rg-lista\">" + arr.map(function (b) { return "<li>" + esc(b[campo || "texto"]) + (b.resolveCom ? ' <span class="rg-sub">— ' + esc(b.resolveCom) + "</span>" : "") + "</li>"; }).join("") + "</ul>" : '<p class="rg-sub">Nenhuma.</p>'; };
    var tl = (x.historico && x.historico.linhaDoTempo) || [];
    return '<div class="rg-detalhe">' +
      '<div class="vf-metric-row">' +
        '<div class="vf-metric"><div class="vf-metric__label">Margem real</div><div class="vf-metric__value">' + pct(r.margemPercent) + "</div><div class=\"vf-metric__foot\">" + (r.limiteInferior ? "limite inferior (subsídio desconhecido)" : esc(CONFIANCAS[c.confiancaGeral] || "")) + "</div></div>" +
        '<div class="vf-metric"><div class="vf-metric__label">Lucro /un</div><div class="vf-metric__value">' + moeda(r.lucro) + "</div></div>" +
        '<div class="vf-metric"><div class="vf-metric__label">Margem exibida (snapshot)</div><div class="vf-metric__value">' + pct(x.snapshot && x.snapshot.margemPercent) + '</div><div class="vf-metric__foot">' + data(x.snapshot && x.snapshot.calculadoEm) + "</div></div>" +
        '<div class="vf-metric"><div class="vf-metric__label">Meta</div><div class="vf-metric__value">' + (x.meta ? pct(x.meta.valor * 100) : "—") + '</div><div class="vf-metric__foot">' + esc(x.meta && x.meta.origem || "") + "</div></div>" +
      "</div>" +
      "<p>" + situacaoTag(x.situacao) + " " + tag(ACOES[x.acao] || x.acao, "primary") + " " + esc((x.motivos || []).join(" ")) + "</p>" +
      '<h3 class="rg-h3">Componentes</h3>' + blocoComponentes(c) +
      '<p class="rg-sub">' + esc(c.componentes && c.componentes.frete && c.componentes.frete.texto || "") + "</p>" +
      '<h3 class="rg-h3">Bloqueios</h3>' + lista(c.bloqueios) +
      '<h3 class="rg-h3">Pendências e inconsistências</h3>' + lista((c.pendencias || []).concat(c.inconsistencias || [])) +
      '<h3 class="rg-h3">Histórico de preço</h3><p class="rg-sub">' + esc(ORIGENS[x.historico && x.historico.origem] || "") + " — " + esc(x.historico && x.historico.motivo || "") + "</p>" +
      (tl.length ? '<ol class="rg-timeline">' + tl.map(function (e) { return "<li><span class=\"rg-sub\">" + data(e.em) + "</span> " + esc(e.descricao || e.tipo) + (vazio(e.preco) ? "" : " · " + moeda(e.preco)) + ' <span class="rg-sub">(' + esc(e.fonte) + ")</span></li>"; }).join("") + "</ol>" : '<p class="rg-sub">Sem eventos.</p>') +
      '<h3 class="rg-h3">Simular ao vivo</h3>' +
      '<div class="vf-cluster"><label class="vf-visually-hidden" for="rg-sim-precos">Preços</label><input class="vf-input vf-input--sm" id="rg-sim-precos" placeholder="Ex.: 89,90; 94,90"> <button class="vf-btn vf-btn--secondary vf-btn--sm" type="button" id="rg-sim-ir">Simular (leitura ao vivo)</button></div>' +
      '<div id="rg-sim-saida"></div>' +
      '<h3 class="rg-h3">Revisão</h3><p class="rg-sub">Proposta válida só para o preço visto ' + moeda(x.fingerprint && x.fingerprint.precoVisto) + " (" + data(x.fingerprint && x.fingerprint.vistoEm) + "). Revisar não altera o anúncio.</p>" +
      '<div class="vf-cluster"><button class="vf-btn vf-btn--primary vf-btn--sm" type="button" data-rg-revisar="APROVADO">Aprovar proposta</button><button class="vf-btn vf-btn--secondary vf-btn--sm" type="button" data-rg-revisar="AJUSTADO">Ajustado manualmente</button><button class="vf-btn vf-btn--ghost vf-btn--sm" type="button" data-rg-revisar="REJEITADO">Rejeitar</button></div>' +
      "</div>";
  }

  function lerPrecos(texto) {
    return String(texto || "").split(/[;\s]+/).map(function (s) { return Number(s.replace(/\./g, "").replace(",", ".")); }).filter(function (n) { return isFinite(n) && n > 0; }).slice(0, 8);
  }

  // ── Cliente HTTP ───────────────────────────────────────────────────────
  function apiBase() { return String(root.VF_API_BASE || DEFAULT_API_BASE).replace(/\/$/, ""); }
  function token() { try { return root.localStorage ? root.localStorage.getItem("vf-token") : null; } catch (_) { return null; } }
  function chamar(caminho, opcoes) {
    var o = opcoes || {};
    var h = { Authorization: "Bearer " + token() };
    var init = { method: o.method || "GET", headers: h };
    if (o.body !== undefined) { h["Content-Type"] = "application/json"; init.body = JSON.stringify(o.body); }
    return fetch(apiBase() + caminho, init).then(function (r) { return r.json().catch(function () { return null; }).then(function (d) { return { ok: r.ok && d && d.ok !== false, status: r.status, data: d }; }); })
      .catch(function (e) { return { ok: false, status: 0, data: { motivo: e && e.message || "Falha de rede." } }; });
  }

  // ── Estado e telas ──────────────────────────────────────────────────────
  var estado = { aba: "global", global: null, contaId: null, pagina: 1, limite: 50, filtros: {}, itemAberto: null };
  function $(id) { return root.document.getElementById(id); }
  function mostrarEstado(html) { $("rg-estado").innerHTML = html || ""; }
  function toast(msg, tom) { var el = root.document.createElement("div"); el.className = "vf-toast"; el.innerHTML = '<div class="vf-toast__content"><div class="vf-toast__title">' + esc(msg) + "</div></div>"; if (tom) el.dataset.tone = tom; $("rg-toasts").appendChild(el); setTimeout(function () { el.remove(); }, 5000); }

  function trocarAba(aba) {
    estado.aba = aba;
    Array.prototype.forEach.call(root.document.querySelectorAll("[data-rg-tab]"), function (b) { var on = b.dataset.rgTab === aba; b.setAttribute("aria-selected", String(on)); b.classList.toggle("is-active", on); });
    Array.prototype.forEach.call(root.document.querySelectorAll("[data-rg-painel]"), function (p) { p.hidden = p.dataset.rgPainel !== aba; });
  }

  function kpi(rotulo, valor, tom) { return '<div class="vf-kpi' + (tom ? " vf-kpi--" + tom : "") + '"><div class="vf-kpi__label">' + esc(rotulo) + '</div><div class="vf-kpi__value">' + valor + "</div></div>"; }

  function renderGlobal(d) {
    var t = d.totais || {};
    $("rg-exec").textContent = d.execucao ? "Auditoria #" + d.execucao.id + " · " + data(d.execucao.finalizadaEm || d.execucao.iniciadaEm) : "Nenhuma auditoria concluída";
    $("rg-kpis").innerHTML = d.execucao ? [
      kpi("Contas avaliadas", inteiro(t.contasAvaliadas) + (t.contasSemAvaliacao ? ' <span class="rg-sub">+' + inteiro(t.contasSemAvaliacao) + " sem avaliação</span>" : "")),
      kpi("Anúncios auditados", inteiro(t.anunciosAuditados)), kpi("Preços corretos", inteiro(t.precosCorretos)),
      kpi("Precisam revisão", inteiro(t.precisamRevisao), "danger"), kpi("Sem margem confiável", inteiro(t.semMargemConfiavel), "warning"),
      kpi("Alterados recentemente", inteiro(t.alteradosRecentemente)), kpi("Risco estimado 30d", moeda(t.riscoFinanceiro30d), "danger"),
    ].join("") : "";
    $("rg-contas").innerHTML = (d.contas || []).map(linhaConta).join("") || '<tr><td colspan="10" class="vf-table__empty">Sem contas na sua carteira nesta auditoria.</td></tr>';
    renderAtivacao(d.ativacao);
  }

  function renderAtivacao(a) {
    if (!a) { $("rg-ativacao").innerHTML = '<div class="vf-empty"><div class="vf-empty__title">Sem plano de ativação</div></div>'; return; }
    var env = a.envProposto ? Object.keys(a.envProposto).map(function (k) { return "<div><code>" + esc(k) + "=" + esc(a.envProposto[k]) + "</code></div>"; }).join("") : '<p class="rg-sub">Nenhuma conta pronta para a próxima onda.</p>';
    $("rg-ativacao").innerHTML =
      (a.alertas && a.alertas.length ? '<div class="vf-banner"><div class="vf-banner__content"><div class="vf-banner__title">Atenção</div><div class="vf-banner__description">' + a.alertas.map(esc).join("<br>") + "</div></div></div>" : "") +
      '<div class="vf-card"><div class="vf-card__header"><div class="vf-card__title">Próxima onda</div></div><div class="vf-card__body">' +
      ((a.proximaOnda || []).map(function (o) { return "<div>" + decisaoTag(o.decisao) + " " + esc(o.clienteNome || "") + " · conta " + esc(o.clienteContaId) + " · seller " + esc(o.sellerId) + ' <span class="rg-sub">' + esc((o.motivos || []).join(" ")) + "</span></div>"; }).join("") || '<p class="rg-sub">—</p>') +
      '<h3 class="rg-h3">Valores propostos (listas explícitas, sem *)</h3>' + env +
      '<ol class="rg-lista">' + (a.passos || []).map(function (p) { return "<li>" + esc(p) + "</li>"; }).join("") + "</ol></div></div>" +
      '<div class="vf-card"><div class="vf-card__header"><div class="vf-card__title">Não liberar agora</div></div><div class="vf-card__body">' +
      ((a.naoLiberar || []).map(function (o) { return "<div>" + decisaoTag(o.decisao) + " conta " + esc(o.clienteContaId) + ' <span class="rg-sub">' + esc((o.motivos || []).join(" ")) + "</span></div>"; }).join("") || '<p class="rg-sub">—</p>') + "</div></div>";
  }

  function opcoes(sel, mapa, rotuloTodos) {
    sel.innerHTML = '<option value="">' + esc(rotuloTodos) + "</option>" + Object.keys(mapa).map(function (k) { var v = Array.isArray(mapa[k]) ? mapa[k][0] : mapa[k]; return '<option value="' + esc(k) + '">' + esc(v) + "</option>"; }).join("");
  }

  function carregarGlobal() {
    mostrarEstado('<div class="vf-loading-state"><span class="vf-spinner vf-spinner--sm"></span> Lendo a última auditoria…</div>');
    return chamar("/resgate/visao-global").then(function (r) {
      if (!r.ok) { mostrarEstado('<div class="vf-banner"><div class="vf-banner__content"><div class="vf-banner__title">Resgate indisponível</div><div class="vf-banner__description">' + esc(r.data && r.data.motivo || "Erro ao carregar.") + "</div></div></div>"); return; }
      mostrarEstado(""); estado.global = r.data; renderGlobal(r.data);
      $("rg-xlsx-global").href = apiBase() + "/resgate/plano.xlsx";
    });
  }

  function abrirConta(contaId) {
    estado.contaId = Number(contaId); estado.pagina = 1; trocarAba("conta");
    try { root.history.replaceState(null, "", "#conta=" + estado.contaId); } catch (_) { /* sem history */ }
    var c = (estado.global && estado.global.contas || []).find(function (x) { return Number(x.clienteContaId) === estado.contaId; }) || {};
    var m = c.matriz || {};
    $("rg-conta-topo").innerHTML = '<div class="vf-cluster vf-cluster--between"><div><strong>' + esc(c.clienteNome || "Conta") + "</strong> " + esc(c.contaNome || "") + ' <span class="rg-sub">seller ' + esc(c.sellerId || "—") + "</span></div><div>" + decisaoTag(m.decisao) + " " + esc((m.motivos || []).join(" ")) + "</div></div>" +
      '<p class="rg-sub">Meta: ' + (c.meta ? pct(c.meta.valor * 100) + " (" + esc(c.meta.origem) + ")" : "—") + " · Modalidades: " + esc(Object.keys(m.modalidades || {}).map(function (f) { var x = m.modalidades[f]; return f + " " + x.status; }).join(", ") || "—") + "</p>";
    $("rg-xlsx-conta").href = apiBase() + "/resgate/contas/" + estado.contaId + "/plano.xlsx";
    return carregarItens();
  }

  function carregarItens() {
    var f = estado.filtros;
    $("rg-itens").innerHTML = '<tr><td colspan="11" class="vf-table__loading">Carregando…</td></tr>';
    return chamar("/resgate/contas/" + estado.contaId + "/itens" + buildQuery({ situacao: f.situacao, acao: f.acao, origem: f.origem, recentes: f.recentes, busca: f.busca, pagina: estado.pagina, limite: estado.limite })).then(function (r) {
      if (!r.ok) { $("rg-itens").innerHTML = '<tr><td colspan="11" class="vf-table__empty">' + esc(r.data && r.data.motivo || "Erro.") + "</td></tr>"; return; }
      estado.itens = r.data.itens;
      $("rg-itens").innerHTML = r.data.itens.map(linhaItem).join("") || '<tr><td colspan="11" class="vf-table__empty">Nenhum anúncio com estes filtros.</td></tr>';
      var paginas = Math.max(1, Math.ceil(r.data.total / estado.limite));
      $("rg-paginacao").innerHTML = '<div class="vf-pagination__info">' + inteiro(r.data.total) + " anúncios · página " + estado.pagina + " de " + paginas + '</div><div class="vf-pagination__actions"><button class="vf-btn vf-btn--ghost vf-btn--sm" type="button" data-rg-pag="-1"' + (estado.pagina <= 1 ? " disabled" : "") + '>Anterior</button><button class="vf-btn vf-btn--ghost vf-btn--sm" type="button" data-rg-pag="1"' + (estado.pagina >= paginas ? " disabled" : "") + ">Próxima</button></div>";
    });
  }

  function abrirItem(itemId) {
    $("rg-drawer").hidden = false; $("rg-drawer-backdrop").hidden = false;
    $("rg-drawer").classList.add("is-open"); $("rg-drawer-backdrop").classList.add("is-open");
    $("rg-drawer-title").textContent = itemId; $("rg-drawer-corpo").innerHTML = '<div class="vf-loading-state"><span class="vf-spinner vf-spinner--sm"></span></div>';
    return chamar("/resgate/contas/" + estado.contaId + "/itens/" + encodeURIComponent(itemId)).then(function (r) {
      if (!r.ok) { $("rg-drawer-corpo").innerHTML = esc(r.data && r.data.motivo || "Erro."); return; }
      estado.itemAberto = r.data.item;
      $("rg-drawer-sub").textContent = r.data.item.titulo || "";
      $("rg-drawer-corpo").innerHTML = detalheItem(r.data.item);
    });
  }
  function fecharItem() {
    $("rg-drawer").classList.remove("is-open"); $("rg-drawer-backdrop").classList.remove("is-open");
    $("rg-drawer").hidden = true; $("rg-drawer-backdrop").hidden = true; estado.itemAberto = null;
  }

  function simular() {
    var x = estado.itemAberto; if (!x) return null;
    $("rg-sim-saida").innerHTML = '<div class="vf-loading-state"><span class="vf-spinner vf-spinner--sm"></span> Cotando no Mercado Livre (somente leitura)…</div>';
    return chamar("/resgate/contas/" + estado.contaId + "/itens/" + encodeURIComponent(x.itemId) + "/simular", { method: "POST", body: { precos: lerPrecos($("rg-sim-precos").value) } }).then(function (r) {
      if (!r.ok) { $("rg-sim-saida").innerHTML = esc(r.data && r.data.motivo || "Erro."); return; }
      var d = r.data;
      $("rg-sim-saida").innerHTML = (d.precoMudouDesdeAuditoria ? '<div class="vf-banner"><div class="vf-banner__content"><div class="vf-banner__title">O preço mudou desde a auditoria</div><div class="vf-banner__description">Preço atual ' + moeda(d.precoAtual) + ": a proposta auditada não vale mais.</div></div></div>" : "") +
        '<table class="vf-table vf-table--compact"><thead><tr><th class="rg-num">Preço</th><th class="rg-num">Comissão</th><th class="rg-num">Frete</th><th class="rg-num">Lucro</th><th class="rg-num">Margem</th><th>Bloqueios</th></tr></thead><tbody>' +
        (d.simulacoes || []).map(function (s) { return '<tr><td class="rg-num">' + moeda(s.preco) + '</td><td class="rg-num">' + moeda(s.comissao && s.comissao.valor) + '</td><td class="rg-num">' + moeda(s.frete && s.frete.valor) + '</td><td class="rg-num">' + moeda(s.resultado && s.resultado.lucro) + '</td><td class="rg-num">' + pct(s.resultado && s.resultado.margemPercent) + "</td><td>" + esc((s.bloqueios || []).map(function (b) { return b.texto; }).join(" ")) + "</td></tr>"; }).join("") +
        "</tbody></table>" + (d.recomendacao ? "<p>Preço mínimo para a meta: <strong>" + (d.recomendacao.ok ? moeda(d.recomendacao.preco) + " → " + pct(d.recomendacao.margemPercent) : esc(d.recomendacao.motivo)) + "</strong></p>" : "");
    });
  }

  function revisar(status) {
    var x = estado.itemAberto; if (!x) return null;
    return chamar("/resgate/contas/" + estado.contaId + "/itens/" + encodeURIComponent(x.itemId) + "/revisao", { method: "POST", body: { status: status, precoVisto: x.fingerprint && x.fingerprint.precoVisto } }).then(function (r) {
      toast(r.ok ? "Revisão registrada: " + status : (r.data && r.data.motivo) || "Erro ao revisar.", r.ok ? "success" : "danger");
      if (r.ok) carregarItens();
    });
  }

  function dryRun() {
    return chamar("/resgate/contas/" + estado.contaId + "/dry-run", { method: "POST", body: {} }).then(function (r) {
      if (!r.ok) { toast((r.data && r.data.motivo) || "Erro no dry-run.", "danger"); return; }
      var res = r.data.resumo || {};
      toast("Dry-run (nada foi enviado): " + (res.ESCREVERIA || 0) + " passariam, " + (res.NAO_ESCREVERIA || 0) + " bloqueadas.", "info");
    });
  }

  function iniciar() {
    if (!root.document || !$("rg-app")) return;
    opcoes($("rg-f-situacao"), SITUACOES, "Todas as classificações"); opcoes($("rg-f-acao"), ACOES, "Todas as ações"); opcoes($("rg-f-origem"), ORIGENS, "Qualquer origem");
    root.document.addEventListener("click", function (ev) {
      var t = ev.target.closest && ev.target.closest("[data-rg-tab],[data-rg-conta],[data-rg-item],[data-rg-pag],[data-rg-revisar],#rg-drawer-fechar,#rg-drawer-backdrop,#rg-sim-ir,#rg-dry-run");
      if (!t) return;
      if (t.dataset.rgTab) trocarAba(t.dataset.rgTab);
      else if (t.dataset.rgConta) abrirConta(t.dataset.rgConta);
      else if (t.dataset.rgItem) abrirItem(t.dataset.rgItem);
      else if (t.dataset.rgPag) { estado.pagina += Number(t.dataset.rgPag); carregarItens(); }
      else if (t.dataset.rgRevisar) revisar(t.dataset.rgRevisar);
      else if (t.id === "rg-sim-ir") simular();
      else if (t.id === "rg-dry-run") dryRun();
      else fecharItem();
    });
    root.document.addEventListener("keydown", function (ev) { if (ev.key === "Escape") fecharItem(); if (ev.key === "Enter" && ev.target.dataset && (ev.target.dataset.rgConta || ev.target.dataset.rgItem)) ev.target.click(); });
    var refiltrar = function () { estado.filtros = { situacao: $("rg-f-situacao").value, acao: $("rg-f-acao").value, origem: $("rg-f-origem").value, recentes: $("rg-f-recentes").checked, busca: $("rg-f-busca").value.trim() }; estado.pagina = 1; if (estado.contaId) carregarItens(); };
    ["rg-f-situacao", "rg-f-acao", "rg-f-origem", "rg-f-recentes"].forEach(function (id) { $(id).addEventListener("change", refiltrar); });
    var timer = null; $("rg-f-busca").addEventListener("input", function () { clearTimeout(timer); timer = setTimeout(refiltrar, 350); });
    // Downloads autenticados: o link aponta para a API; o token vai por fetch → blob.
    ["rg-xlsx-global", "rg-xlsx-conta"].forEach(function (id) {
      $(id).addEventListener("click", function (ev) {
        ev.preventDefault();
        fetch(this.href, { headers: { Authorization: "Bearer " + token() } }).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.blob(); })
          .then(function (b) { var a = root.document.createElement("a"); a.href = URL.createObjectURL(b); a.download = "venforce-resgate.xlsx"; a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000); })
          .catch(function (e) { toast("Erro ao baixar: " + e.message, "danger"); });
      });
    });
    // Link direto: #conta=<id>&item=<MLB>&situacao=<…> (compartilhável com o responsável).
    carregarGlobal().then(function () {
      var h = new URLSearchParams(String(root.location && root.location.hash || "").replace(/^#/, ""));
      if (h.get("aba") === "ativacao") trocarAba("ativacao");
      if (h.get("conta")) {
        if (h.get("situacao")) { $("rg-f-situacao").value = h.get("situacao"); estado.filtros.situacao = h.get("situacao"); }
        abrirConta(h.get("conta")).then(function () { if (h.get("item")) abrirItem(h.get("item")); });
      }
    });
  }

  return { iniciar: iniciar, moeda: moeda, pct: pct, inteiro: inteiro, esc: esc, buildQuery: buildQuery, linhaConta: linhaConta, linhaItem: linhaItem, detalheItem: detalheItem, lerPrecos: lerPrecos, SITUACOES: SITUACOES };
});
