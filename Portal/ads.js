// Portal/ads.js — Página de Mercado Ads
//
// PROJETO 01 — Ads MVP real (Maio/2026).
//
// O que esta versão faz a mais que a anterior:
//   - Carrega resumo mensal REAL via GET /ads/resumo-mensal quando há
//     cliente e mês selecionados (endpoint já existente no repo).
//   - Persiste resumo via PUT /ads/resumo-mensal.
//   - Mantém checklist e feedback em /ads/acompanhamento (intocados).
//   - Mantém o array MOCK como fallback quando não há cliente/mês,
//     para a página continuar visualmente útil ao abrir.
//   - Adiciona modo de EDIÇÃO: os 8 campos numéricos podem ser preenchidos
//     manualmente e salvos no banco.
//
// O QUE NÃO MUDA:
//   - Backend (rotas, payloads, tabelas).
//   - HTML (todos os IDs preservados; novos elementos opcionais).
//   - CSS principal (apenas adições no fim do arquivo).
//   - Layout/sidebar.
//   - Comportamento da checklist.

(function () {
  "use strict";

  // ─── Compatibilidade: aceita com OU sem vf-common.js ───────────────────────
  const VF = (window.vf && window.vf.auth) ? window.vf : null;
  const API_BASE    = (VF && VF.config.API_BASE)    || "https://venforce-server.onrender.com";
  const STORAGE_KEY = (VF && VF.config.STORAGE_KEY) || "vf-token";

  function getToken() {
    const t = localStorage.getItem(STORAGE_KEY);
    if (!t) { window.location.replace("index.html"); return null; }
    return t;
  }
  getToken();
  if (typeof initLayout === "function") initLayout();

  // ─── Constantes ────────────────────────────────────────────────────────────
  // Dados mockados — usados APENAS quando não há cliente/mês selecionados,
  // para a tela não abrir vazia e pra deixar uma referência de UI viva.
  const ADS_DADOS_MENSAIS = [
    { mes:1, label:"Janeiro",   investimentoAds:6100,  gmvAds:140900, roas:23.10, faturamentoTotal:179519.29, canceladosValor:449.72,  canceladosPct:0.40, devolvidosValor:294.72, tacos:3.40 },
    { mes:2, label:"Fevereiro", investimentoAds:4700,  gmvAds:108800, roas:23.15, faturamentoTotal:122597.28, canceladosValor:2157.11, canceladosPct:1.80, devolvidosValor:188.59, tacos:3.83 },
    { mes:3, label:"Março",     investimentoAds:7700,  gmvAds:117900, roas:15.31, faturamentoTotal:143752.64, canceladosValor:2518.07, canceladosPct:1.80, devolvidosValor:169.74, tacos:5.36 },
    { mes:4, label:"Abril",     investimentoAds:7700,  gmvAds:146300, roas:19.00, faturamentoTotal:181729.05, canceladosValor:121.47,  canceladosPct:0.20, devolvidosValor:0,      tacos:4.24 },
    { mes:5, label:"Maio",      investimentoAds:2300,  gmvAds: 43600, roas:18.96, faturamentoTotal: 51290.75, canceladosValor:0,       canceladosPct:0,    devolvidosValor:0,      tacos:4.48 },
  ];

  const MES_LABELS = [
    "", "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
    "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
  ];

  const ADS_CAMPANHAS = ["Todas", "Campanha Geral", "Produtos Premium", "Liquidação"];

  const ADS_CHECKLIST_ITEMS = [
    "Dados de Ads conferidos",
    "ROAS analisado",
    "TACOS analisado",
    "Cancelados / devolvidos revisados",
    "Feedback enviado ao cliente",
    "Cliente respondeu",
  ];

  // Chaves correspondentes no JSONB do backend.
  const ADS_CHECKLIST_KEYS = [
    "dadosConferidos",
    "roasAnalisado",
    "tacosAnalisado",
    "canceladosRevisados",
    "feedbackEnviado",
    "clienteRespondeu",
  ];

  // Campos do resumo mensal (mapeamento bidirecional UI ↔ backend).
  const RESUMO_CAMPOS = [
    { key: "investimentoAds",   label: "Investimento Ads",   tipo: "brl" },
    { key: "gmvAds",            label: "GMV Ads",            tipo: "brl" },
    { key: "roas",              label: "ROAS",               tipo: "num" },
    { key: "faturamentoTotal",  label: "Faturamento Total",  tipo: "brl" },
    { key: "canceladosValor",   label: "Cancelados (R$)",    tipo: "brl" },
    { key: "canceladosPct",     label: "Cancelados (%)",     tipo: "pct" },
    { key: "devolvidosValor",   label: "Devolvidos (R$)",    tipo: "brl" },
    { key: "tacos",             label: "TACOS (%)",          tipo: "pct" },
  ];

  // ─── Estado ────────────────────────────────────────────────────────────────
  // Resumo mensal carregado do backend. Quando null, usamos mock.
  let ADS_RESUMO_ATUAL          = null;   // { investimentoAds, gmvAds, ... }
  let ADS_RESUMO_ORIGEM         = "mock"; // "mock" | "backend" | "vazio"
  let ADS_RESUMO_UPDATED_AT     = null;
  let ADS_RESUMO_DIRTY          = false;  // alterações de resumo não salvas

  // Acompanhamento (checklist + feedback)
  let ADS_CLIENTES_LISTA        = [];
  let ADS_ACOMPANHAMENTO_ATUAL  = null;
  let ADS_CHECKLIST_ATUAL       = emptyChecklist();
  let ADS_FEEDBACK_ATUAL        = "";
  let ADS_ACOMPANHAMENTO_DIRTY  = false;
  let ADS_SAVING_ACOMPANHAMENTO = false;
  let ADS_SAVING_RESUMO         = false;

  function emptyChecklist() {
    return { semana1: {}, semana2: {}, semana3: {}, semana4: {} };
  }

  // ─── Helpers de formatação ────────────────────────────────────────────────
  function adsFmtBRL(n) {
    return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(n) || 0);
  }
  function adsFmtNum(n, decimals = 2) {
    return Number(n || 0).toLocaleString("pt-BR", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  }
  function adsFmtPct(n, decimals = 2) {
    return adsFmtNum(n, decimals) + "%";
  }
  function adsEscape(s) {
    const d = document.createElement("div");
    d.textContent = String(s ?? "");
    return d.innerHTML;
  }
  function adsToNumber(v) {
    if (v === null || v === undefined || v === "") return 0;
    if (typeof v === "number") return Number.isFinite(v) ? v : 0;
    // aceita "1.234,56" ou "1234,56" ou "1234.56"
    const s = String(v).trim().replace(/\s/g, "");
    if (!s) return 0;
    const onlyComma = s.indexOf(",") >= 0 && s.indexOf(".") < 0;
    const norm = onlyComma ? s.replace(",", ".") :
                 s.replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", ".");
    const n = Number(norm);
    return Number.isFinite(n) ? n : 0;
  }

  // ─── Status TACOS ─────────────────────────────────────────────────────────
  function adsStatusTacos(tacos) {
    const t = Number(tacos) || 0;
    if (t <= 0) return { label: "Sem dados", cls: "ads-badge-neutral" };
    if (t <= 4) return { label: "Saudável",  cls: "ads-badge-success" };
    if (t <= 5) return { label: "Atenção",   cls: "ads-badge-warning" };
    return         { label: "Crítico",    cls: "ads-badge-danger"  };
  }

  // ─── Filtros ──────────────────────────────────────────────────────────────
  function adsGetFiltroMes() {
    const sel = document.getElementById("ads-filtro-mes");
    return sel ? Number(sel.value) || 0 : 0;
  }

  function adsGetFiltroMesRef() {
    const mesNum = adsGetFiltroMes();
    if (!mesNum) return null;
    const ano = new Date().getFullYear();
    return `${ano}-${String(mesNum).padStart(2, "0")}`;
  }

  function adsGetClienteSlug() {
    const sel = document.getElementById("ads-filtro-cliente");
    return sel ? (sel.value || "").trim() : "";
  }

  function adsGetLojaCampanha() {
    const sel = document.getElementById("ads-filtro-campanha");
    return (sel && sel.value) ? sel.value.trim() : "todas";
  }

  // Devolve a "linha" do mês atualmente em foco.
  // Se há resumo carregado do backend → usa ele.
  // Se não, mas há filtro de mês → usa o mock daquele mês.
  // Se não há filtro → devolve o array mock inteiro (visão de overview).
  function adsGetDadosFiltrados() {
    const mes = adsGetFiltroMes();
    const slug = adsGetClienteSlug();

    if (slug && mes && ADS_RESUMO_ATUAL) {
      return [resumoToRow(ADS_RESUMO_ATUAL, mes)];
    }
    if (slug && mes && ADS_RESUMO_ORIGEM === "vazio") {
      // cliente + mês selecionados, mas nada salvo no banco ainda → linha zerada
      return [resumoToRow({}, mes)];
    }

    if (!mes) return ADS_DADOS_MENSAIS;
    return ADS_DADOS_MENSAIS.filter((d) => d.mes === mes);
  }

  // Converte um resumo (objeto camelCase) para o formato de "linha" usado pelo render.
  function resumoToRow(resumo, mesNum) {
    return {
      mes:              mesNum,
      label:            MES_LABELS[mesNum] || String(mesNum),
      investimentoAds:  Number(resumo.investimentoAds  || 0),
      gmvAds:           Number(resumo.gmvAds           || 0),
      roas:             Number(resumo.roas             || 0),
      faturamentoTotal: Number(resumo.faturamentoTotal || 0),
      canceladosValor:  Number(resumo.canceladosValor  || 0),
      canceladosPct:    Number(resumo.canceladosPct    || 0),
      devolvidosValor:  Number(resumo.devolvidosValor  || 0),
      tacos:            Number(resumo.tacos            || 0),
    };
  }

  // ─── API fetch ────────────────────────────────────────────────────────────
  async function adsFetch(path, options = {}) {
    const token = localStorage.getItem(STORAGE_KEY);
    const headers = {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${token}`,
      ...(options.headers || {}),
    };
    return fetch(`${API_BASE}${path}`, { ...options, headers });
  }

  // ─── Banner de origem ─────────────────────────────────────────────────────
  function adsSetBanner(text, kind = "info") {
    const el = document.getElementById("ads-source-banner");
    if (!el) return;
    if (!text) {
      el.hidden = true;
      el.textContent = "";
      el.className = "ads-source-banner";
      return;
    }
    el.hidden = false;
    el.textContent = text;
    el.className = "ads-source-banner ads-source-banner--" + kind;
  }

  // ─── Carregar clientes reais ──────────────────────────────────────────────
  async function adsCarregarClientes() {
    const sel = document.getElementById("ads-filtro-cliente");
    if (!sel) return;
    try {
      const res = await adsFetch("/ads/clientes");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data.ok || !Array.isArray(data.clientes)) throw new Error("Resposta inválida");
      ADS_CLIENTES_LISTA = data.clientes;
      sel.innerHTML = `<option value="">Todos</option>` +
        data.clientes.map((c) =>
          `<option value="${adsEscape(c.slug)}">${adsEscape(c.nome)}</option>`
        ).join("");
    } catch (err) {
      console.warn("[ads] falha ao carregar clientes:", err.message);
      sel.innerHTML = `<option value="">Todos</option>`;
    }
  }

  // ─── Carregar resumo mensal real ──────────────────────────────────────────
  async function adsCarregarResumoMensal() {
    const clienteSlug  = adsGetClienteSlug();
    const mes          = adsGetFiltroMesRef();
    const lojaCampanha = adsGetLojaCampanha();

    // Sem cliente ou sem mês → mock
    if (!clienteSlug || !mes) {
      ADS_RESUMO_ATUAL      = null;
      ADS_RESUMO_ORIGEM     = "mock";
      ADS_RESUMO_UPDATED_AT = null;
      ADS_RESUMO_DIRTY      = false;
      adsSetBanner(
        "Mostrando dados de exemplo. Selecione cliente e mês para carregar dados reais e editar.",
        "info"
      );
      adsAtualizarBotaoSalvarResumo();
      return;
    }

    try {
      const params = new URLSearchParams({ clienteSlug, mes, lojaCampanha });
      const res = await adsFetch(`/ads/resumo-mensal?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data.ok) throw new Error(data.erro || "Resposta inválida");

      const r = data.resumo || null;

      // Se backend retornou objeto vazio (sem registro ainda) → "vazio"
      const hasAny = r && (
        Number(r.investimentoAds)  > 0 ||
        Number(r.gmvAds)           > 0 ||
        Number(r.faturamentoTotal) > 0 ||
        Number(r.tacos)            > 0
      );

      if (!hasAny) {
        ADS_RESUMO_ATUAL      = {};
        ADS_RESUMO_ORIGEM     = "vazio";
        ADS_RESUMO_UPDATED_AT = null;
        ADS_RESUMO_DIRTY      = false;
        adsSetBanner(
          "Sem resumo salvo para este mês. Preencha os campos no card 'Editar dados do mês' e clique Salvar.",
          "warning"
        );
      } else {
        ADS_RESUMO_ATUAL      = r;
        ADS_RESUMO_ORIGEM     = "backend";
        ADS_RESUMO_UPDATED_AT = r.updatedAt || null;
        ADS_RESUMO_DIRTY      = false;
        adsSetBanner("");
      }
    } catch (err) {
      console.warn("[ads] falha ao carregar resumo:", err.message);
      ADS_RESUMO_ATUAL      = null;
      ADS_RESUMO_ORIGEM     = "mock";
      ADS_RESUMO_UPDATED_AT = null;
      ADS_RESUMO_DIRTY      = false;
      adsSetBanner(
        "Não consegui carregar o resumo do banco. Mostrando exemplo. Detalhe: " + err.message,
        "danger"
      );
    }

    adsRenderEditor();
    adsAtualizarBotaoSalvarResumo();
  }

  // ─── Salvar resumo mensal ─────────────────────────────────────────────────
  async function adsSalvarResumoMensal() {
    if (!adsCanSalvarResumo()) return;
    const clienteSlug  = adsGetClienteSlug();
    const mes          = adsGetFiltroMesRef();
    const lojaCampanha = adsGetLojaCampanha();

    // Coleta valores dos inputs do editor.
    const payload = {
      clienteSlug,
      mes,
      lojaCampanha,
    };
    for (const c of RESUMO_CAMPOS) {
      const inp = document.getElementById("ads-resumo-input-" + c.key);
      payload[c.key] = inp ? adsToNumber(inp.value) : 0;
    }

    ADS_SAVING_RESUMO = true;
    const btn = document.getElementById("ads-btn-salvar-resumo");
    const btnLabelOriginal = btn ? btn.textContent : "";
    if (btn) { btn.disabled = true; btn.textContent = "Salvando..."; }
    adsSetResumoStatus("Salvando...", "ads-save-loading");

    try {
      const res = await adsFetch("/ads/resumo-mensal", {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.erro || `HTTP ${res.status}`);

      // O backend devolve o resumo atualizado.
      ADS_RESUMO_ATUAL      = data.resumo || payload;
      ADS_RESUMO_ORIGEM     = "backend";
      ADS_RESUMO_UPDATED_AT = (data.resumo && data.resumo.updatedAt) || new Date().toISOString();
      ADS_RESUMO_DIRTY      = false;

      adsSetBanner("");
      adsSetResumoStatus("Resumo salvo", "ads-save-ok");
      setTimeout(() => adsLimparResumoStatus("ads-save-ok"), 2500);

      adsRender(); // re-renderiza cards e tabela com os valores salvos
      adsRenderEditor();
    } catch (err) {
      console.warn("[ads] falha ao salvar resumo:", err.message);
      adsSetResumoStatus("Erro: " + err.message, "ads-save-error");
      setTimeout(() => adsLimparResumoStatus("ads-save-error"), 4000);
    } finally {
      ADS_SAVING_RESUMO = false;
      if (btn) {
        btn.textContent = btnLabelOriginal || "Salvar dados do mês";
        btn.disabled    = !adsCanSalvarResumo();
      }
    }
  }

  function adsCanSalvarResumo() {
    return !!(adsGetClienteSlug() && adsGetFiltroMesRef() && !ADS_SAVING_RESUMO);
  }
  function adsAtualizarBotaoSalvarResumo() {
    const btn = document.getElementById("ads-btn-salvar-resumo");
    if (btn) btn.disabled = !adsCanSalvarResumo();
  }
  function adsSetResumoStatus(msg, cls) {
    const el = document.getElementById("ads-resumo-status");
    if (!el) return;
    el.textContent  = msg;
    el.className    = "ads-save-status" + (cls ? " " + cls : "");
    el.style.display = "inline";
  }
  function adsLimparResumoStatus(onlyCls) {
    const el = document.getElementById("ads-resumo-status");
    if (!el) return;
    if (onlyCls && !el.classList.contains(onlyCls)) return;
    el.style.display = "none";
    el.textContent   = "";
    el.className     = "ads-save-status";
  }

  // ─── Carregar acompanhamento (checklist + feedback) ───────────────────────
  async function adsCarregarAcompanhamento() {
    const clienteSlug = adsGetClienteSlug();
    const mes         = adsGetFiltroMesRef();

    if (!clienteSlug || !mes) {
      ADS_CHECKLIST_ATUAL      = emptyChecklist();
      ADS_FEEDBACK_ATUAL       = "";
      ADS_ACOMPANHAMENTO_ATUAL = null;
      ADS_ACOMPANHAMENTO_DIRTY = false;
      adsAtualizarFeedbackTextarea();
      adsAtualizarUpdatedAt(null);
      adsRenderChecklist();
      adsAtualizarBotaoSalvar();
      return;
    }

    const loja = adsGetLojaCampanha();
    adsSetSaveStatus("Carregando...", "ads-save-loading");

    try {
      const params = new URLSearchParams({ clienteSlug, mes, lojaCampanha: loja });
      const res    = await adsFetch(`/ads/acompanhamento?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data.ok || !data.acompanhamento) throw new Error("Resposta inválida");

      const a = data.acompanhamento;
      ADS_ACOMPANHAMENTO_ATUAL = a;
      ADS_CHECKLIST_ATUAL = (a.checklist && typeof a.checklist === "object" && !Array.isArray(a.checklist))
        ? a.checklist
        : emptyChecklist();
      ADS_FEEDBACK_ATUAL       = a.feedbackText || "";
      ADS_ACOMPANHAMENTO_DIRTY = false;

      adsAtualizarFeedbackTextarea();
      adsAtualizarUpdatedAt(a.updatedAt);
      adsRenderChecklist();
      adsSetSaveStatus("Carregado", "ads-save-ok");
      setTimeout(() => adsLimparSaveStatus("ads-save-ok"), 2500);
    } catch (err) {
      console.warn("[ads] falha ao carregar acompanhamento:", err.message);
      ADS_CHECKLIST_ATUAL      = emptyChecklist();
      ADS_FEEDBACK_ATUAL       = "";
      ADS_ACOMPANHAMENTO_DIRTY = false;
      adsAtualizarFeedbackTextarea();
      adsAtualizarUpdatedAt(null);
      adsRenderChecklist();
      adsSetSaveStatus("Erro ao carregar", "ads-save-error");
      setTimeout(() => adsLimparSaveStatus("ads-save-error"), 3500);
    }

    adsAtualizarBotaoSalvar();
  }

  function adsAtualizarFeedbackTextarea() {
    const ta = document.getElementById("ads-feedback-textarea");
    if (ta) ta.value = ADS_FEEDBACK_ATUAL;
  }

  function adsAtualizarUpdatedAt(updatedAt) {
    const el = document.getElementById("ads-updated-at");
    if (!el) return;
    if (!updatedAt) { el.style.display = "none"; el.textContent = ""; return; }
    const data = new Date(updatedAt);
    if (Number.isNaN(data.getTime())) { el.style.display = "none"; return; }
    const str = data.toLocaleString("pt-BR", {
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
    el.textContent  = `Última atualização: ${str}`;
    el.style.display = "block";
  }

  // ─── Status de salvamento (acompanhamento) ────────────────────────────────
  function adsSetSaveStatus(msg, cls) {
    const el = document.getElementById("ads-save-status");
    if (!el) return;
    el.textContent = msg;
    el.className   = `ads-save-status${cls ? " " + cls : ""}`;
    el.style.display = "inline";
  }

  function adsLimparSaveStatus(onlyCls) {
    const el = document.getElementById("ads-save-status");
    if (!el) return;
    if (onlyCls && !el.classList.contains(onlyCls)) return;
    el.style.display = "none";
    el.textContent   = "";
    el.className     = "ads-save-status";
  }

  function adsAtualizarSaveStatus() {
    if (ADS_ACOMPANHAMENTO_DIRTY) {
      adsSetSaveStatus("Alterações não salvas", "ads-unsaved");
    } else {
      adsLimparSaveStatus();
    }
    adsAtualizarBotaoSalvar();
  }

  function adsCanSave() {
    return !!(adsGetClienteSlug() && adsGetFiltroMesRef() && !ADS_SAVING_ACOMPANHAMENTO);
  }

  function adsAtualizarBotaoSalvar() {
    const btn = document.getElementById("ads-btn-salvar");
    if (!btn) return;
    btn.disabled = !adsCanSave();
  }

  // ─── Salvar acompanhamento ────────────────────────────────────────────────
  async function adsSalvarAcompanhamento() {
    if (!adsCanSave()) return;
    const clienteSlug  = adsGetClienteSlug();
    const mes          = adsGetFiltroMesRef();
    const lojaCampanha = adsGetLojaCampanha();

    ADS_SAVING_ACOMPANHAMENTO = true;
    const btn  = document.getElementById("ads-btn-salvar");
    if (btn) { btn.disabled = true; btn.textContent = "Salvando..."; }
    adsSetSaveStatus("Salvando...", "ads-save-loading");

    try {
      const res = await adsFetch("/ads/acompanhamento", {
        method: "PUT",
        body: JSON.stringify({
          clienteSlug,
          mes,
          lojaCampanha,
          checklist:    ADS_CHECKLIST_ATUAL,
          feedbackText: ADS_FEEDBACK_ATUAL,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.erro || `HTTP ${res.status}`);

      ADS_ACOMPANHAMENTO_DIRTY = false;
      ADS_ACOMPANHAMENTO_ATUAL = data.acompanhamento;
      adsAtualizarUpdatedAt(data.acompanhamento && data.acompanhamento.updatedAt);
      adsSetSaveStatus("Acompanhamento salvo", "ads-save-ok");
      setTimeout(() => adsLimparSaveStatus("ads-save-ok"), 2500);
    } catch (err) {
      console.warn("[ads] falha ao salvar:", err.message);
      adsSetSaveStatus("Erro: " + err.message, "ads-save-error");
      setTimeout(() => adsLimparSaveStatus("ads-save-error"), 4000);
    } finally {
      ADS_SAVING_ACOMPANHAMENTO = false;
      if (btn) { btn.textContent = "Salvar acompanhamento"; btn.disabled = !adsCanSave(); }
    }
  }

  // ─── Cards de resumo ──────────────────────────────────────────────────────
  function adsRenderSummary() {
    const grid = document.getElementById("ads-summary-grid");
    if (!grid) return;
    const dados = adsGetDadosFiltrados();

    if (!dados.length) {
      grid.innerHTML = `<div class="ads-summary-empty">Sem dados para o filtro selecionado.</div>`;
      return;
    }

    const totalInv  = dados.reduce((a, d) => a + Number(d.investimentoAds || 0), 0);
    const totalGmv  = dados.reduce((a, d) => a + Number(d.gmvAds || 0), 0);
    const roasVals  = dados.map((d) => Number(d.roas)).filter((v) => v > 0);
    const roasMed   = roasVals.length ? roasVals.reduce((a, b) => a + b, 0) / roasVals.length : 0;
    const totalFat  = dados.reduce((a, d) => a + Number(d.faturamentoTotal || 0), 0);
    const tacosVals = dados.map((d) => Number(d.tacos)).filter((v) => v > 0);
    const tacosMed  = tacosVals.length ? tacosVals.reduce((a, b) => a + b, 0) / tacosVals.length : 0;

    const cards = [
      { label: "Investimento Ads",   value: adsFmtBRL(totalInv),       accent: "ads",     icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>` },
      { label: "GMV Ads",            value: adsFmtBRL(totalGmv),       accent: "ads",     icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/></svg>` },
      { label: "ROAS médio",         value: adsFmtNum(roasMed) + "x",  accent: "purple",  icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/></svg>` },
      { label: "Faturamento Total",  value: adsFmtBRL(totalFat),       accent: "purple",  icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20M17 6H9.5a3.5 3.5 0 0 0 0 7H14a3.5 3.5 0 0 1 0 7H6"/></svg>` },
      { label: "TACOS médio",        value: adsFmtPct(tacosMed),       accent: tacosMed > 5 ? "danger" : tacosMed > 4 ? "warning" : "success", icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73L13 2.27a2 2 0 0 0-2 0L4 6.27A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>` },
      { label: "Feedbacks enviados", value: String(dados.length * 4),  accent: "neutral", icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>` },
    ];

    grid.innerHTML = cards.map((c) => `
      <div class="ads-summary-card ads-summary-card--${adsEscape(c.accent)}">
        <div class="ads-summary-icon">${c.icon}</div>
        <div class="ads-summary-body">
          <div class="ads-summary-value">${adsEscape(c.value)}</div>
          <div class="ads-summary-label">${adsEscape(c.label)}</div>
        </div>
      </div>`).join("");
  }

  // ─── Tabela mensal ────────────────────────────────────────────────────────
  function adsRenderTabela() {
    const tbody = document.getElementById("ads-table-body");
    const badge = document.getElementById("ads-table-total");
    if (!tbody) return;

    const dados = adsGetDadosFiltrados();
    if (badge) { badge.textContent = String(dados.length); badge.style.display = "inline-block"; }

    if (!dados.length) {
      tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:2rem;color:var(--vf-text-m);">Nenhum dado para o filtro selecionado.</td></tr>`;
      return;
    }

    tbody.innerHTML = dados.map((d) => {
      const st = adsStatusTacos(d.tacos);
      const roasClass = d.roas >= 20 ? "ads-num-good" : d.roas >= 15 ? "" : (d.roas > 0 ? "ads-num-warn" : "");
      return `
        <tr>
          <td class="ads-td-mes"><strong>${adsEscape(d.label)}</strong></td>
          <td class="num ads-td-inv">${adsEscape(adsFmtBRL(d.investimentoAds))}</td>
          <td class="num">${adsEscape(adsFmtBRL(d.gmvAds))}</td>
          <td class="num ${roasClass}">${adsEscape(adsFmtNum(d.roas))}x</td>
          <td class="num">${adsEscape(adsFmtBRL(d.faturamentoTotal))}</td>
          <td class="num">
            <span>${adsEscape(adsFmtBRL(d.canceladosValor))}</span>
            ${d.canceladosPct > 0 ? `<span class="ads-td-pct">${adsEscape(adsFmtPct(d.canceladosPct))}</span>` : ""}
          </td>
          <td class="num">${adsEscape(adsFmtBRL(d.devolvidosValor))}</td>
          <td class="num"><strong>${adsEscape(adsFmtPct(d.tacos))}</strong></td>
          <td class="center"><span class="ads-badge ${adsEscape(st.cls)}">${adsEscape(st.label)}</span></td>
        </tr>`;
    }).join("");
  }

  // ─── Editor de resumo mensal ──────────────────────────────────────────────
  // Renderiza um pequeno formulário com os 8 campos preenchíveis.
  // O HTML novo opcional é o container #ads-resumo-editor. Se o HTML não
  // tiver esse container, o editor simplesmente não aparece — sem quebrar.
  function adsRenderEditor() {
    const container = document.getElementById("ads-resumo-editor");
    if (!container) return;

    const clienteSlug = adsGetClienteSlug();
    const mes         = adsGetFiltroMesRef();

    if (!clienteSlug || !mes) {
      container.innerHTML = `
        <div class="ads-editor-empty">
          Selecione um <strong>cliente</strong> e um <strong>mês</strong> para editar os dados.
        </div>`;
      adsAtualizarBotaoSalvarResumo();
      return;
    }

    const r = ADS_RESUMO_ATUAL || {};
    const fields = RESUMO_CAMPOS.map((c) => {
      const v = r[c.key];
      const valNum = (v === null || v === undefined || v === "") ? "" : Number(v);
      const step = c.tipo === "brl" ? "0.01" : c.tipo === "pct" ? "0.01" : "0.01";
      return `
        <div class="vf-form-group ads-editor-field">
          <label for="ads-resumo-input-${c.key}">${adsEscape(c.label)}</label>
          <input id="ads-resumo-input-${c.key}"
                 data-resumo-key="${adsEscape(c.key)}"
                 class="vf-input ads-resumo-input"
                 type="number"
                 inputmode="decimal"
                 step="${step}"
                 min="0"
                 value="${valNum === "" ? "" : valNum}"
                 placeholder="0,00">
        </div>`;
    }).join("");

    container.innerHTML = `
      <div class="ads-editor-grid">${fields}</div>
      <div class="ads-editor-actions">
        <button type="button" id="ads-btn-salvar-resumo" class="vf-btn-primary" style="margin:0;">
          Salvar dados do mês
        </button>
        <span id="ads-resumo-status" class="ads-save-status" style="display:none;"></span>
      </div>
    `;

    // Listeners dos inputs e do botão
    container.querySelectorAll(".ads-resumo-input").forEach((inp) => {
      inp.addEventListener("input", () => {
        ADS_RESUMO_DIRTY = true;
        adsSetResumoStatus("Alterações não salvas", "ads-unsaved");
      });
    });
    const btn = document.getElementById("ads-btn-salvar-resumo");
    if (btn) btn.addEventListener("click", adsSalvarResumoMensal);
    adsAtualizarBotaoSalvarResumo();
  }

  // ─── Checklist semanal ────────────────────────────────────────────────────
  function adsGetCheck(sem, idx) {
    const semKey  = `semana${sem}`;
    const itemKey = ADS_CHECKLIST_KEYS[idx];
    const semObj  = ADS_CHECKLIST_ATUAL[semKey];
    return !!(semObj && semObj[itemKey]);
  }

  function adsSetCheck(sem, idx, value) {
    const semKey  = `semana${sem}`;
    const itemKey = ADS_CHECKLIST_KEYS[idx];
    if (!ADS_CHECKLIST_ATUAL[semKey]) ADS_CHECKLIST_ATUAL[semKey] = {};
    if (value) ADS_CHECKLIST_ATUAL[semKey][itemKey] = true;
    else delete ADS_CHECKLIST_ATUAL[semKey][itemKey];
    ADS_ACOMPANHAMENTO_DIRTY = true;
    adsAtualizarSaveStatus();
  }

  function adsRenderChecklist() {
    const grid = document.getElementById("ads-checklist-grid");
    if (!grid) return;

    const clienteSlug = adsGetClienteSlug();
    const mes         = adsGetFiltroMesRef();

    if (!clienteSlug || !mes) {
      grid.innerHTML = `
        <div class="ads-checklist-empty">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          Selecione um <strong>cliente</strong> e um <strong>mês</strong> para carregar o checklist.
        </div>`;
      adsAtualizarBotaoSalvar();
      return;
    }

    const semanas = [1, 2, 3, 4];
    grid.innerHTML = semanas.map((sem) => {
      const checks = ADS_CHECKLIST_ITEMS.map((item, idx) => {
        const checked = adsGetCheck(sem, idx);
        return `
          <label class="ads-check-item ${checked ? "is-checked" : ""}">
            <input type="checkbox" class="ads-check-input" data-semana="${sem}" data-idx="${idx}" ${checked ? "checked" : ""}>
            <span class="ads-check-box" aria-hidden="true">
              ${checked ? `<svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 6 4.5 9.5 11 2"/></svg>` : ""}
            </span>
            <span class="ads-check-label">${adsEscape(item)}</span>
          </label>`;
      }).join("");

      const total   = ADS_CHECKLIST_ITEMS.length;
      const done    = ADS_CHECKLIST_ITEMS.filter((_, idx) => adsGetCheck(sem, idx)).length;
      const pct     = Math.round((done / total) * 100);
      const allDone = done === total;

      return `
        <div class="ads-week-card ${allDone ? "is-complete" : ""}">
          <div class="ads-week-header">
            <div class="ads-week-title">
              <span class="ads-week-num">Semana ${sem}</span>
              ${allDone ? `<svg class="ads-week-done-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>` : ""}
            </div>
            <div class="ads-week-progress" aria-label="Progresso da semana ${sem}">
              <div class="ads-week-progress-bar" style="width:${pct}%" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"></div>
            </div>
            <span class="ads-week-progress-label">${done}/${total}</span>
          </div>
          <div class="ads-week-checks">${checks}</div>
        </div>`;
    }).join("");

    grid.querySelectorAll(".ads-check-input").forEach((input) => {
      input.addEventListener("change", () => {
        const sem = Number(input.dataset.semana);
        const idx = Number(input.dataset.idx);
        adsSetCheck(sem, idx, input.checked);
        adsRenderChecklist();
      });
    });

    adsAtualizarBotaoSalvar();
  }

  // ─── Feedback para o cliente ──────────────────────────────────────────────
  function adsGerarFeedback() {
    const dados = adsGetDadosFiltrados();

    if (!dados.length) {
      const ta = document.getElementById("ads-feedback-textarea");
      if (ta) ta.value = "Nenhum dado disponível para o período selecionado.";
      ADS_FEEDBACK_ATUAL = ta ? ta.value : "";
      ADS_ACOMPANHAMENTO_DIRTY = true;
      adsAtualizarSaveStatus();
      return;
    }

    const d        = dados.length === 1 ? dados[0] : null;
    const mesLabel = d ? d.label : "período selecionado";

    const totalInv = dados.reduce((a, v) => a + Number(v.investimentoAds || 0), 0);
    const totalGmv = dados.reduce((a, v) => a + Number(v.gmvAds || 0), 0);
    const totalFat = dados.reduce((a, v) => a + Number(v.faturamentoTotal || 0), 0);
    const roasMed  = dados.reduce((a, v) => a + Number(v.roas || 0), 0) / dados.length;
    const tacosMed = dados.reduce((a, v) => a + Number(v.tacos || 0), 0) / dados.length;
    const st       = adsStatusTacos(tacosMed);

    const linhas = [
      `📊 Relatório de Mercado Ads — ${mesLabel}`,
      ``,
      `💰 Investimento em Ads: ${adsFmtBRL(totalInv)}`,
      `📈 GMV gerado pelos Ads: ${adsFmtBRL(totalGmv)}`,
      `🔁 ROAS médio: ${adsFmtNum(roasMed)}x`,
      `🏪 Faturamento total da loja: ${adsFmtBRL(totalFat)}`,
      `📌 TACOS médio: ${adsFmtPct(tacosMed)} (${st.label})`,
      ``,
      `✅ Análise:`,
    ];

    if (tacosMed <= 0) {
      linhas.push(`Sem dados suficientes para análise de TACOS no período. Preencha o resumo do mês antes de gerar feedback.`);
    } else if (tacosMed <= 4) {
      linhas.push(`Os investimentos em Ads estão bem calibrados. O TACOS de ${adsFmtPct(tacosMed)} está dentro da faixa saudável (até 4%), indicando boa eficiência de custo.`);
    } else if (tacosMed <= 5) {
      linhas.push(`O TACOS de ${adsFmtPct(tacosMed)} está em zona de atenção. Recomendamos revisão das campanhas de menor ROAS para otimizar o retorno.`);
    } else {
      linhas.push(`O TACOS de ${adsFmtPct(tacosMed)} está acima do ideal. É importante revisar os lances e pausar campanhas com ROAS abaixo de 10x para reduzir o custo proporcional.`);
    }

    linhas.push(``, `📌 Próximos passos:`);
    linhas.push(`- Revisar campanhas com ROAS abaixo da média`);
    linhas.push(`- Acompanhar evolução dos cancelados e devolvidos`);
    linhas.push(`- Ajustar orçamento conforme sazonalidade`);

    const ta = document.getElementById("ads-feedback-textarea");
    if (ta) ta.value = linhas.join("\n");
    ADS_FEEDBACK_ATUAL       = ta ? ta.value : "";
    ADS_ACOMPANHAMENTO_DIRTY = true;
    adsAtualizarSaveStatus();
  }

  function adsCopiarFeedback() {
    const ta = document.getElementById("ads-feedback-textarea");
    const ok = document.getElementById("ads-copy-ok");
    if (!ta || !ta.value.trim()) return;
    navigator.clipboard.writeText(ta.value).then(() => {
      if (ok) { ok.style.display = "inline"; setTimeout(() => { ok.style.display = "none"; }, 2200); }
    }).catch(() => {
      ta.select();
      try { document.execCommand("copy"); } catch (_) { /* noop */ }
    });
  }

  // ─── Preencher selects auxiliares ─────────────────────────────────────────
  function adsFillSelects() {
    const selCamp = document.getElementById("ads-filtro-campanha");
    if (selCamp) {
      selCamp.innerHTML = ADS_CAMPANHAS.map((c, i) =>
        `<option value="${i === 0 ? "" : adsEscape(c)}">${adsEscape(c)}</option>`
      ).join("");
    }

    const periodEl = document.getElementById("ads-checklist-period");
    if (periodEl) {
      const mesRef = adsGetFiltroMesRef();
      if (mesRef) {
        const [y, m] = mesRef.split("-").map(Number);
        const d = new Date(y, m - 1, 1);
        const s = d.toLocaleDateString("pt-BR", { month: "short", year: "numeric" });
        periodEl.textContent = s.charAt(0).toUpperCase() + s.slice(1);
      } else {
        const now = new Date();
        periodEl.textContent = now.toLocaleDateString("pt-BR", { month: "short", year: "numeric" })
          .replace(/^\w/, (c) => c.toUpperCase());
      }
    }
  }

  // ─── Render completo ──────────────────────────────────────────────────────
  function adsRender() {
    adsRenderSummary();
    adsRenderTabela();
    adsRenderChecklist();
    adsFillSelects();
  }

  async function adsRecarregarTudo() {
    await adsCarregarResumoMensal();
    adsRender();
    await adsCarregarAcompanhamento();
  }

  // ─── Event listeners ─────────────────────────────────────────────────────
  document.getElementById("ads-btn-atualizar")?.addEventListener("click", adsRecarregarTudo);
  document.getElementById("ads-filtro-mes")?.addEventListener("change", adsRecarregarTudo);
  document.getElementById("ads-filtro-cliente")?.addEventListener("change", adsRecarregarTudo);
  document.getElementById("ads-filtro-campanha")?.addEventListener("change", async () => {
    await adsCarregarResumoMensal();
    adsRender();
    await adsCarregarAcompanhamento();
  });
  document.getElementById("ads-btn-gerar")?.addEventListener("click", adsGerarFeedback);
  document.getElementById("ads-btn-copiar")?.addEventListener("click", adsCopiarFeedback);
  document.getElementById("ads-btn-salvar")?.addEventListener("click", adsSalvarAcompanhamento);
  document.getElementById("ads-feedback-textarea")?.addEventListener("input", (e) => {
    ADS_FEEDBACK_ATUAL       = e.target.value;
    ADS_ACOMPANHAMENTO_DIRTY = true;
    adsAtualizarSaveStatus();
  });

  // Aviso ao sair com alterações pendentes (resumo OU acompanhamento)
  window.addEventListener("beforeunload", (e) => {
    if (ADS_RESUMO_DIRTY || ADS_ACOMPANHAMENTO_DIRTY) {
      e.preventDefault();
      e.returnValue = "";
      return "";
    }
  });

  // ─── Init ─────────────────────────────────────────────────────────────────
  (async function init() {
    adsFillSelects();
    adsRender();
    await adsCarregarClientes();
    await adsRecarregarTudo();
  })();
})();
