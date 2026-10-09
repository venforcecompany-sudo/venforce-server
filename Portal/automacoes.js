// Portal/automacoes.js
// Otimizador de Precificação ML — fluxo único:
//   cliente + conta (do Shell V3) → margem-alvo → prontidão automática
//   (grant + base MELI) → Analisar loja → diagnóstico completo assíncrono →
//   KPIs + prioridades → encaminhar detalhes para a página Relatórios.
//
// F5 — o CLIENTE não é mais escolhido aqui. Ele vem do Shell V3, pelo mesmo
// caminho de fechamentos-api.js: o evento DOM `vf:context`, que é a ponte
// documentada para script clássico (MASTER_SPEC §6.5/§15.3) — este arquivo
// roda ANTES de vf-shell.js (module, deferido) terminar, então não dá para
// `import` nem assinar window.VF.context.subscribe() na hora da avaliação.
//
// Escopo CONTA (data-vf-scope="account"): um cliente pode ter 2+ contas
// Mercado Livre (server/services/clienteContas — Fundação de Contas). Sem
// clienteContaId, automacoesRoutes.js escolhia um grant em silêncio
// (resolveMlGrant({clienteId}) caía no principal/fallback) — selecionar
// ML1 ou ML2 no Shell podia analisar a MESMA conta. Agora toda automação
// envia `clienteContaId`, e o backend resolve o ml_user_id daquela conta
// especificamente via resolveMarketplaceAccountContext (nunca escolhe outra
// em silêncio; bloqueia com erro claro se a conta não for informada e o
// cliente tiver 2+ contas ML). O Shell só libera o conteúdo desta tela
// quando cliente E conta estão resolvidos (state READY).
//
// GET /automacoes/clientes só diz se o cliente está habilitado para
// automações. A PRONTIDÃO (hasGrantMl, baseStatus, prontoParaAnalise) vem de
// GET /automacoes/prontidao?clienteSlug&clienteContaId — grant e base da
// CONTA selecionada no Shell, pelo mesmo resolver da análise. A listagem é
// client-level (soma as bases de todas as contas) e marcava "2 bases
// vinculadas" quando cada conta tinha a sua — falsa duplicidade.
//
// A base NÃO é escolhida manualmente: o backend resolve a base MELI vinculada
// ao cliente (custo/imposto/taxa fixa). O grant fornece anúncios/preço/comissão/frete.
// Nenhuma fórmula é calculada aqui.

const STORAGE_KEY = "vf-token";
const API_BASE = "https://venforce-server.onrender.com";

function getToken() {
  const t = localStorage.getItem(STORAGE_KEY);
  if (!t) { window.location.replace("index.html"); return null; }
  return t;
}

const TOKEN = getToken();
const user = JSON.parse(localStorage.getItem("vf-user") || "{}");
const role = String(user.role || "").toLowerCase();
const canAccessAutomacoes =
  role === "admin" || role === "user" || role === "membro";
// F5/Bloco F — sem permissão volta para a CARTEIRA, não para
// dashboard.html. O dashboard é uma tela legada, fora da navegação V3 e
// ainda no layout.js: mandar para lá quem esbarrou num 403 dentro do
// Shell V3 troca a sidebar debaixo do usuário e o deixa num lugar de
// onde ele não sabe voltar. A Carteira é a home operacional do V3 e
// trata carteira vazia honestamente (NO_PORTFOLIO).
if (!canAccessAutomacoes) window.location.replace("carteira.html");
// F5 — initLayout() saiu junto com o layout.js: quem monta a navegação
// agora é vf-shell.js (que também cuida de token ausente e do desvio de
// `seller`). Sem shim aqui porque este arquivo foi migrado de verdade — o
// no-op só existe nas páginas cujo JS não foi tocado.

// ─── Estado ──────────────────────────────────────────────────────────────
let ALL_CLIENTES = [];               // contexto de prontidão vindo do backend
let DIAG_POLL_TIMER = null;
let DIAG_RELATORIO_ID = null;
let DIAG_ULTIMO_STATUS = "";
let RELATORIO_CONCLUIDO_ID = null;

const POLL_INTERVAL_MS = 3000;

// ─── Utilidades ──────────────────────────────────────────────────────────
function clearSession() {
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem("vf-user");
  window.location.replace("index.html");
}

function escapeHTML(s) {
  const d = document.createElement("div");
  d.textContent = s == null ? "" : String(s);
  return d.innerHTML;
}

const brlFmt = new Intl.NumberFormat("pt-BR", {
  style: "currency", currency: "BRL", minimumFractionDigits: 2, maximumFractionDigits: 2,
});
const pctFmt = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function fmtMoney(v) {
  const n = Number(v);
  return Number.isFinite(n) ? brlFmt.format(n) : "—";
}
function fmtMcFraction(v) {
  const n = Number(v);
  return Number.isFinite(n) ? `${pctFmt.format(n * 100)}%` : "—";
}
function fmtInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : "0";
}

function formatarDataHora(iso) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString("pt-BR"); }
  catch (_) { return String(iso); }
}

// "Atualização": data curta + idade relativa da base.
function formatarIdadeBase(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const dataCurta = d.toLocaleDateString("pt-BR");
  const dias = Math.floor((Date.now() - d.getTime()) / 86400000);
  let idade;
  if (dias <= 0) idade = "hoje";
  else if (dias === 1) idade = "ontem";
  else if (dias < 30) idade = `há ${dias} dias`;
  else if (dias < 365) idade = `há ${Math.floor(dias / 30)} meses`;
  else idade = `há ${Math.floor(dias / 365)} ano(s)`;
  return `${dataCurta} · ${idade}`;
}

function getMargemDecimal() {
  const raw = Number(document.getElementById("auto-margem")?.value);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  return raw / 100;
}

// ─── Feedback / banners ──────────────────────────────────────────────────
function setFeedback(msg, tone) {
  const el = document.getElementById("auto-feedback");
  if (!el) return;
  if (!msg) { el.hidden = true; el.innerHTML = ""; return; }
  el.className = `vf-banner${tone ? " is-" + tone : ""}`;
  el.innerHTML = `<div class="vf-banner__content"><p class="vf-banner__description">${escapeHTML(msg)}</p></div>`;
  el.hidden = false;
}

function setStateBanner({ tone, titulo, descricao } = {}) {
  const el = document.getElementById("auto-state-banner");
  if (!el) return;
  if (!titulo && !descricao) { el.hidden = true; el.innerHTML = ""; return; }
  el.className = `vf-banner${tone ? " is-" + tone : ""}`;
  el.innerHTML = `
    <div class="vf-banner__content">
      ${titulo ? `<p class="vf-banner__title">${escapeHTML(titulo)}</p>` : ""}
      ${descricao ? `<p class="vf-banner__description">${escapeHTML(descricao)}</p>` : ""}
    </div>`;
  el.hidden = false;
}

// ─── Prontidão dos clientes (fonte, não seletor) ─────────────────────────
// A lista deixou de virar <option>: ela é consultada pelo slug que o Shell
// escolheu. `prontidaoCarregada` distingue "ainda não sei" de "sei que este
// cliente não está aqui" — sem isso, o intervalo entre o boot e a resposta
// pareceria "cliente sem grant ML", que é uma afirmação.
let prontidaoCarregada = false;
let prontidaoErro = null;

async function loadClientes() {
  if (!TOKEN) return;
  prontidaoCarregada = false;
  prontidaoErro = null;

  try {
    const res = await fetch(`${API_BASE}/automacoes/clientes`, {
      headers: { Authorization: "Bearer " + TOKEN },
    });
    if (res.status === 401) { clearSession(); return; }
    if (res.status === 403) { window.location.replace("carteira.html"); return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json().catch(() => ({}));
    ALL_CLIENTES = Array.isArray(data.clientes) ? data.clientes : [];
    prontidaoCarregada = true;
  } catch (err) {
    ALL_CLIENTES = [];
    prontidaoErro = "Não foi possível carregar a prontidão deste cliente. Recarregue a página.";
  }
  onClienteChange();
}

// O cliente do contexto. Nenhum fallback para "o primeiro da lista": sem
// contexto não há cliente, e o Shell já cuida de dizer isso (scope="account").
function slugDoContexto() {
  const ctx = window.VF && window.VF.context ? window.VF.context.getContext() : null;
  return ctx && ctx.clienteSlug ? ctx.clienteSlug : "";
}

// A conta Mercado Livre selecionada no Shell — vai em toda chamada que
// executa uma automação. Sem ela (state != READY), o Shell nem mostra o
// conteúdo desta página (data-vf-scope="account").
function contaIdDoContexto() {
  const ctx = window.VF && window.VF.context ? window.VF.context.getContext() : null;
  return ctx && ctx.clienteContaId ? ctx.clienteContaId : null;
}

// Cliente do contexto presente na lista de automações (habilitado).
function getClienteHabilitado() {
  const slug = slugDoContexto();
  if (!slug) return null;
  return ALL_CLIENTES.find((c) => (c.slug || "") === slug) || null;
}

// Chave cliente+conta: a prontidão só vale para a conta em que foi pedida.
function chaveDoContexto() {
  const slug = slugDoContexto();
  return slug ? `${slug}:${contaIdDoContexto() || ""}` : "";
}

// ─── Prontidão da CONTA selecionada ──────────────────────────────────────
// `prontidaoContaSeq` descarta respostas antigas: trocar de ML1 para ML2
// enquanto a de ML1 ainda está em voo nunca pode pintar ML1 na tela de ML2.
let PRONTIDAO_CONTA = null;
let prontidaoContaChave = "";
let prontidaoContaErro = null;
let prontidaoContaSeq = 0;

async function loadProntidaoConta() {
  const seq = ++prontidaoContaSeq;
  const chave = chaveDoContexto();
  PRONTIDAO_CONTA = null;
  prontidaoContaErro = null;
  prontidaoContaChave = chave;
  if (!TOKEN || !chave) return;

  const params = new URLSearchParams({ clienteSlug: slugDoContexto() });
  const contaId = contaIdDoContexto();
  if (contaId) params.set("clienteContaId", String(contaId));

  try {
    const res = await fetch(`${API_BASE}/automacoes/prontidao?${params}`, {
      headers: { Authorization: "Bearer " + TOKEN },
    });
    if (seq !== prontidaoContaSeq) return;
    if (res.status === 401) { clearSession(); return; }
    const json = await res.json().catch(() => ({}));
    if (seq !== prontidaoContaSeq) return;
    if (!res.ok) {
      if (res.status === 403 && json?.code !== "CONTA_NAO_PERTENCE_AO_CLIENTE") { window.location.replace("carteira.html"); return; }
      if (json?.code && ["CONTA_AMBIGUA", "CONTA_NAO_PERTENCE_AO_CLIENTE", "MARKETPLACE_INCOMPATIVEL", "CONTA_INATIVA"].includes(json.code)) {
        window.VF?.context?.signalContextError?.({ code: json.code });
      }
      throw new Error(json?.erro || `HTTP ${res.status}`);
    }
    if (!json || !json.prontidao) throw new Error("Resposta sem prontidão.");
    PRONTIDAO_CONTA = json.prontidao;
  } catch (err) {
    if (seq !== prontidaoContaSeq) return;
    PRONTIDAO_CONTA = null;
    prontidaoContaErro = `Não foi possível carregar a prontidão desta conta (${err.message}). Recarregue a página.`;
  }
  onClienteChange();
}

// Cliente habilitado + prontidão da conta ATUAL. null enquanto a prontidão
// desta conta não chegou — nunca a de outra conta.
function getClienteAtual() {
  const cliente = getClienteHabilitado();
  if (!cliente || !PRONTIDAO_CONTA || prontidaoContaChave !== chaveDoContexto()) return null;
  return { ...cliente, ...PRONTIDAO_CONTA, slug: cliente.slug };
}

function renderIdentidadeCliente() {
  const nomeEl = document.getElementById("auto-cliente-nome");
  const contaEl = document.getElementById("auto-conta-nome");
  const hintEl = document.getElementById("auto-cliente-hint");
  const store = window.VF && window.VF.context ? window.VF.context : null;
  const cliente = store && store.getClienteAtual ? store.getClienteAtual() : null;
  const contaMeta = store && store.getAccountMeta ? store.getAccountMeta() : null;
  const slug = slugDoContexto();

  if (nomeEl) nomeEl.textContent = cliente ? cliente.nome : slug || "—";
  if (contaEl) contaEl.textContent = contaMeta ? contaMeta.nome : "—";
  if (!hintEl) return;

  if (!slug) hintEl.textContent = "Escolha o cliente na barra lateral.";
  else if (!prontidaoCarregada && !prontidaoErro) hintEl.textContent = "Verificando a prontidão deste cliente…";
  else if (prontidaoErro) hintEl.textContent = prontidaoErro;
  else if (!getClienteHabilitado()) hintEl.textContent = "Este cliente não está habilitado para automações.";
  else if (prontidaoContaErro) hintEl.textContent = prontidaoContaErro;
  else if (!getClienteAtual()) hintEl.textContent = "Verificando a prontidão desta conta…";
  else hintEl.textContent = slug;
}

// ─── Prontidão (grant + base) ────────────────────────────────────────────
function onClienteChange() {
  // Trocar de cliente encerra qualquer resultado/processamento visível.
  resetResultadoEProcessamento();
  setFeedback("");
  renderIdentidadeCliente();

  const ctx = getClienteAtual();
  const readiness = document.getElementById("auto-readiness");
  const btn = document.getElementById("btn-otimizador-analisar");
  const btnPlanilha = document.getElementById("btn-baixar-planilha-precificacao");
  const btnModeloBase = document.getElementById("btn-gerar-modelo-base");
  const btnAbrirBases = document.getElementById("btn-abrir-bases-custo");

  if (!ctx) {
    if (readiness) readiness.hidden = true;
    // Cliente escolhido, prontidão já carregada e ele NÃO está na lista: é
    // uma resposta, não um limbo. Sem cliente ou ainda carregando, o Shell e
    // a dica já explicam — um banner de erro aqui seria ruído.
    if (slugDoContexto() && prontidaoCarregada && !prontidaoErro && !getClienteHabilitado()) {
      setStateBanner({
        tone: "warning",
        titulo: "Cliente sem automações habilitadas",
        descricao: "Este cliente não aparece na lista de automações do Mercado Livre. Confira o grant ML em Clientes e Contas.",
      });
    } else if (prontidaoErro || prontidaoContaErro) {
      setStateBanner({ tone: "danger", titulo: "Prontidão indisponível", descricao: prontidaoErro || prontidaoContaErro });
    } else {
      setStateBanner({});
    }
    if (btn) btn.disabled = true;
    if (btnPlanilha) btnPlanilha.disabled = true;
    if (btnModeloBase) { btnModeloBase.hidden = true; btnModeloBase.disabled = true; }
    if (btnAbrirBases) btnAbrirBases.hidden = true;
    return;
  }

  renderReadiness(ctx);
  if (btn) btn.disabled = !ctx.prontoParaAnalise;
  // Baixar planilha só exige grant ML — não depende de base vinculada.
  if (btnPlanilha) btnPlanilha.disabled = !ctx.hasGrantMl;
  const podeGerarModelo = ctx.hasGrantMl && ctx.baseStatus === "ausente";
  if (btnModeloBase) { btnModeloBase.hidden = !podeGerarModelo; btnModeloBase.disabled = !podeGerarModelo; }
  if (btnAbrirBases) btnAbrirBases.hidden = !podeGerarModelo;
}

function setStatusChip(id, tone, texto) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = `vf-status${tone ? " is-" + tone : ""}`;
  el.textContent = texto;
}

function renderReadiness(ctx) {
  const readiness = document.getElementById("auto-readiness");
  if (readiness) readiness.hidden = false;

  // Grant ML
  setStatusChip("rd-grant", ctx.hasGrantMl ? "success" : "danger",
    ctx.hasGrantMl ? "Conectado" : "Não conectado");

  // Base de custos
  const baseEl = document.getElementById("rd-base");
  const updEl = document.getElementById("rd-updated");
  if (ctx.baseStatus === "ok") {
    if (baseEl) baseEl.textContent = ctx.baseMeliNome || ctx.baseMeli || "—";
    if (updEl) updEl.textContent = formatarIdadeBase(ctx.baseMeliUpdatedAt);
  } else if (ctx.baseStatus === "multiplas") {
    if (baseEl) baseEl.textContent = `${ctx.basesMeliCount} bases vinculadas`;
    if (updEl) updEl.textContent = "—";
  } else {
    if (baseEl) baseEl.textContent = "Nenhuma vinculada";
    if (updEl) updEl.textContent = "—";
  }

  // Status geral + banner de bloqueio
  if (!ctx.hasGrantMl) {
    setStatusChip("rd-status", "danger", "Requer correção");
    setStateBanner({
      tone: "danger",
      titulo: "Cliente sem grant ML",
      descricao: "Conecte a conta do Mercado Livre deste cliente para habilitar a análise.",
    });
  } else if (ctx.baseStatus === "ausente") {
    setStatusChip("rd-status", "warning", "Planilha disponível");
    setStateBanner({
      tone: "warning",
      titulo: "Cliente sem base MELI vinculada",
      descricao: "O diagnóstico financeiro está bloqueado. Baixe a planilha de precificação ou gere um modelo simples para preencher e importar em Bases de Custo.",
    });
  } else if (ctx.baseStatus === "multiplas") {
    setStatusChip("rd-status", "warning", "Requer correção");
    setStateBanner({
      tone: "warning",
      titulo: "Mais de uma base MELI vinculada",
      descricao: "Corrija os vínculos em Bases de Custo para executar o diagnóstico. A planilha de precificação continua disponível para download.",
    });
  } else {
    setStatusChip("rd-status", "success", "Pronto");
    setStateBanner({});
  }
}

// ─── Alternância de estados da página ────────────────────────────────────
function setConfigDisabled(disabled) {
  ["auto-margem", "btn-otimizador-analisar", "btn-baixar-planilha-precificacao", "btn-gerar-modelo-base"]
    .forEach((id) => { const el = document.getElementById(id); if (el) el.disabled = disabled; });
}

function resetResultadoEProcessamento() {
  stopPolling();
  DIAG_RELATORIO_ID = null;
  DIAG_ULTIMO_STATUS = "";
  RELATORIO_CONCLUIDO_ID = null;
  const prog = document.getElementById("auto-progress-card");
  const results = document.getElementById("auto-results");
  if (prog) prog.hidden = true;
  if (results) results.hidden = true;
}

// ─── Análise (início + polling) ──────────────────────────────────────────
async function analisarLoja() {
  if (!TOKEN) return;
  const ctx = getClienteAtual();
  if (!ctx) { setFeedback("Selecione um cliente para iniciar a análise.", "danger"); return; }
  if (!ctx.prontoParaAnalise) {
    setFeedback("Este cliente não está pronto. Ajuste grant/base antes de analisar.", "danger");
    return;
  }

  setFeedback("");
  setConfigDisabled(true);
  mostrarProcessando("Iniciando análise da loja…", "");

  try {
    const res = await fetch(`${API_BASE}/automacoes/diagnostico-completo/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + TOKEN },
      body: JSON.stringify({ clienteSlug: ctx.slug, margemAlvo: getMargemDecimal(), clienteContaId: contaIdDoContexto() }),
    });
    if (res.status === 401) { clearSession(); return; }

    const json = await res.json().catch(() => ({}));

    // 403 de carteira (permissão) continua indo para a Carteira. 403
    // CONTA_NAO_PERTENCE_AO_CLIENTE (Fundação de Contas) é outra coisa —
    // tratado no bloco de erro estrutural de conta, abaixo.
    if (res.status === 403 && json?.code !== "CONTA_NAO_PERTENCE_AO_CLIENTE") {
      window.location.replace("carteira.html");
      return;
    }

    // Relatório já em andamento para este cliente: reaproveita o polling.
    if (res.status === 409 && json?.relatorio_id) {
      setFeedback(json?.erro || "Já existe uma análise em andamento para este cliente.", "info");
      startPolling(json.relatorio_id);
      return;
    }
    // Erro estrutural de conta (Fundação de Contas): a seleção do Shell
    // ficou inconsistente entre o momento em que a página carregou e o
    // clique (ex.: conta desativada por outra aba). O store decide o que
    // fazer com o contexto — nunca escolher outra conta em silêncio.
    if (json?.code && ["CONTA_AMBIGUA", "CONTA_NAO_PERTENCE_AO_CLIENTE", "MARKETPLACE_INCOMPATIVEL", "CONTA_INATIVA"].includes(json.code)) {
      window.VF?.context?.signalContextError?.({ code: json.code });
      throw new Error(json.erro || "A conta selecionada não é mais válida para esta operação.");
    }
    if (!res.ok || !json?.ok) {
      throw new Error(json?.erro || `HTTP ${res.status}`);
    }

    startPolling(json.relatorio_id);
  } catch (err) {
    mostrarErro(err?.message || "Erro ao iniciar a análise.");
  }
}

function mostrarProcessando(statusTxt, metaTxt) {
  const prog = document.getElementById("auto-progress-card");
  const results = document.getElementById("auto-results");
  if (results) results.hidden = true;
  if (prog) prog.hidden = false;
  const st = document.getElementById("auto-progress-status");
  const meta = document.getElementById("auto-progress-meta");
  const bar = document.getElementById("auto-progress-bar");
  if (st) st.textContent = statusTxt || "Processando…";
  if (meta) meta.textContent = metaTxt || "";
  if (bar) { bar.style.width = "8%"; bar.className = "vf-progress__bar"; }
}

function mostrarErro(msg) {
  stopPolling();
  setConfigDisabled(false);
  const prog = document.getElementById("auto-progress-card");
  if (prog) prog.hidden = true;
  setFeedback(msg, "danger");
}

function startPolling(relatorioId) {
  if (!relatorioId) return;
  DIAG_RELATORIO_ID = relatorioId;
  stopPolling();
  pollOnce(relatorioId);
  DIAG_POLL_TIMER = setInterval(() => pollOnce(relatorioId), POLL_INTERVAL_MS);
}

function stopPolling() {
  if (DIAG_POLL_TIMER) { clearInterval(DIAG_POLL_TIMER); DIAG_POLL_TIMER = null; }
}

async function pollOnce(relatorioId) {
  try {
    const res = await fetch(`${API_BASE}/automacoes/diagnostico-completo/${encodeURIComponent(relatorioId)}`, {
      headers: { Authorization: "Bearer " + TOKEN },
    });
    if (res.status === 401) { clearSession(); return; }
    if (res.status === 403) { window.location.replace("carteira.html"); return; }
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json?.ok) throw new Error(json?.erro || `HTTP ${res.status}`);

    const rel = json.relatorio || {};
    const status = String(rel.status || "").toLowerCase();
    DIAG_ULTIMO_STATUS = status;

    if (status === "processando") {
      renderProcessando(rel);
    } else if (status === "concluido") {
      stopPolling();
      await onConcluido(rel);
    } else if (status === "erro") {
      mostrarErro(rel.observacoes || "A análise terminou com erro.");
    } else {
      renderProcessando(rel);
    }
  } catch (err) {
    mostrarErro(`Falha ao acompanhar a análise: ${err.message}`);
  }
}

function renderProcessando(rel) {
  const total = Number(rel.total_itens ?? 0) || 0;
  const st = document.getElementById("auto-progress-status");
  const meta = document.getElementById("auto-progress-meta");
  const bar = document.getElementById("auto-progress-bar");
  if (st) st.textContent = "Analisando anúncios ativos da loja…";
  if (meta) meta.textContent = total > 0 ? `Itens processados até agora: ${total}` : "Buscando anúncios no Mercado Livre…";
  if (bar) {
    const pct = Math.min(95, Math.max(8, Math.round(15 + Math.log10(total + 1) * 35)));
    bar.style.width = `${pct}%`;
    bar.className = "vf-progress__bar";
  }
}

// ─── Conclusão: KPIs + prioridades ───────────────────────────────────────
async function onConcluido(rel) {
  RELATORIO_CONCLUIDO_ID = rel.id;
  const bar = document.getElementById("auto-progress-bar");
  if (bar) { bar.style.width = "100%"; bar.className = "vf-progress__bar is-success"; }

  renderKpis(rel);

  const sub = document.getElementById("auto-results-sub");
  if (sub) {
    sub.textContent = `Relatório #${rel.id} · ${rel.cliente_slug || "—"} · concluído em ${formatarDataHora(rel.created_at)}`;
  }

  // Buscar itens do relatório concluído para montar as prioridades.
  try {
    const itens = await buscarItensRelatorio(rel.id);
    renderPrioridades(itens);
  } catch (err) {
    renderPrioridades([]);
    setFeedback(`Não foi possível carregar as prioridades: ${err.message}`, "warning");
  }

  const prog = document.getElementById("auto-progress-card");
  const results = document.getElementById("auto-results");
  if (prog) prog.hidden = true;
  if (results) results.hidden = false;
  setConfigDisabled(false);
  setFeedback(`Análise concluída (relatório #${rel.id}).`, "success");
}

function kpiCard({ label, value, footTone, foot }) {
  return `
    <div class="vf-kpi">
      <span class="vf-kpi__label">${escapeHTML(label)}</span>
      <span class="vf-kpi__value">${escapeHTML(value)}</span>
      ${foot ? `<span class="vf-kpi__foot${footTone ? " is-" + footTone : ""}">${escapeHTML(foot)}</span>` : ""}
    </div>`;
}

function renderKpis(rel) {
  const grid = document.getElementById("auto-kpis");
  if (!grid) return;
  const total = Number(rel.total_itens ?? 0) || 0;
  const comBase = Number(rel.itens_com_base ?? 0) || 0;
  const semBase = Number(rel.itens_sem_base ?? 0) || 0;
  const criticos = Number(rel.itens_criticos ?? 0) || 0;
  const atencao = Number(rel.itens_atencao ?? 0) || 0;
  const saudaveis = Number(rel.itens_saudaveis ?? 0) || 0;
  const mcMediaNum = Number(rel.mc_media);
  const mcMedia = Number.isFinite(mcMediaNum) ? `${pctFmt.format(mcMediaNum * 100)}%` : "—";

  grid.innerHTML = [
    kpiCard({ label: "Total", value: fmtInt(total) }),
    kpiCard({ label: "Com base", value: fmtInt(comBase) }),
    kpiCard({ label: "Sem base", value: fmtInt(semBase), footTone: semBase > 0 ? "warning" : "", foot: semBase > 0 ? "sem custo cadastrado" : "" }),
    kpiCard({ label: "Críticos", value: fmtInt(criticos), footTone: criticos > 0 ? "danger" : "", foot: criticos > 0 ? "margem negativa" : "" }),
    kpiCard({ label: "Atenção", value: fmtInt(atencao), footTone: atencao > 0 ? "warning" : "", foot: atencao > 0 ? "abaixo do alvo" : "" }),
    kpiCard({ label: "Saudáveis", value: fmtInt(saudaveis), footTone: saudaveis > 0 ? "success" : "", foot: saudaveis > 0 ? "no alvo" : "" }),
    kpiCard({ label: "MC média", value: mcMedia, footTone: Number.isFinite(mcMediaNum) ? (mcMediaNum < 0 ? "danger" : "success") : "", foot: Number.isFinite(mcMediaNum) ? "margem de contribuição" : "" }),
  ].join("");
}

async function buscarItensRelatorio(id) {
  const res = await fetch(`${API_BASE}/automacoes/relatorios/${encodeURIComponent(id)}`, {
    headers: { Authorization: "Bearer " + TOKEN },
  });
  if (res.status === 401) { clearSession(); return []; }
  if (res.status === 403) { window.location.replace("carteira.html"); return []; }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json?.ok) throw new Error(json?.erro || `HTTP ${res.status}`);
  return Array.isArray(json.itens) ? json.itens : [];
}

// Ordenação: 1 críticos, 2 sem base, 3 sem frete, 4 sem comissão, 5 atenção,
// 6 menor MC (desempate geral). Exibe no máximo 10 itens.
const DIAG_RANK = { critico: 0, sem_base: 1, sem_frete: 2, sem_comissao: 3, atencao: 4 };
const DIAG_META = {
  critico: { label: "Crítico", tone: "danger" },
  atencao: { label: "Atenção", tone: "warning" },
  saudavel: { label: "Saudável", tone: "success" },
  sem_base: { label: "Sem base", tone: "neutral" },
  sem_frete: { label: "Sem frete", tone: "warning" },
  sem_comissao: { label: "Sem comissão", tone: "warning" },
  sem_dados: { label: "Sem dados", tone: "neutral" },
};

function renderPrioridades(itens) {
  const tbody = document.getElementById("auto-priorities-tbody");
  const count = document.getElementById("auto-priorities-count");
  if (!tbody) return;

  const lista = Array.isArray(itens) ? itens.slice() : [];
  lista.sort((a, b) => {
    const ra = DIAG_RANK[a.diagnostico] ?? 5;
    const rb = DIAG_RANK[b.diagnostico] ?? 5;
    if (ra !== rb) return ra - rb;
    const ma = Number(a.mc); const mb = Number(b.mc);
    const va = Number.isFinite(ma) ? ma : Infinity;
    const vb = Number.isFinite(mb) ? mb : Infinity;
    return va - vb;
  });

  const top = lista.slice(0, 10);
  if (count) { count.hidden = false; count.textContent = String(top.length); }

  tbody.innerHTML = "";
  if (top.length === 0) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="7" class="vf-auto-priorities__empty">Nenhuma prioridade encontrada. Todos os itens analisados estão saudáveis.</td>`;
    tbody.appendChild(tr);
    return;
  }

  top.forEach((it) => {
    const meta = DIAG_META[it.diagnostico] || { label: it.diagnostico || "—", tone: "neutral" };
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="vf-mono">${escapeHTML(it.item_id || "—")}</td>
      <td class="vf-truncate" title="${escapeHTML(it.titulo || "")}">${escapeHTML(it.titulo || "—")}</td>
      <td class="num">${escapeHTML(fmtMoney(it.preco_efetivo))}</td>
      <td class="num">${escapeHTML(fmtMcFraction(it.mc))}</td>
      <td class="num">${escapeHTML(fmtMoney(it.preco_alvo))}</td>
      <td><span class="vf-status is-${meta.tone}">${escapeHTML(meta.label)}</span></td>
      <td>${escapeHTML(it.acao_recomendada || "—")}</td>
    `;
    tbody.appendChild(tr);
  });
}

// ─── Ações finais ────────────────────────────────────────────────────────
async function baixarXlsx(relatorioId) {
  if (!TOKEN || !relatorioId) return;
  try {
    const res = await fetch(`${API_BASE}/automacoes/relatorios/${encodeURIComponent(relatorioId)}/export/xlsx`, {
      headers: { Authorization: "Bearer " + TOKEN },
    });
    if (res.status === 401) { clearSession(); return; }
    if (res.status === 403) { window.location.replace("carteira.html"); return; }
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      throw new Error(json?.erro || `HTTP ${res.status}`);
    }
    const blob = await res.blob();
    const disp = res.headers.get("content-disposition") || "";
    const nomeMatch = disp.match(/filename="?([^"]+)"?/i);
    const filename = nomeMatch?.[1] || `relatorio-${relatorioId}.xlsx`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    setFeedback(`Erro ao exportar XLSX: ${err.message}`, "danger");
  }
}

// Planilha de precificação a partir do grant ML — não exige base vinculada,
// não inicia diagnóstico e não cria relatório. Reaproveita a mesma matriz/
// fórmulas do XLSX do relatório concluído (baixarXlsx acima), mas com os
// campos vindos da base em branco quando não há base vinculada.
async function baixarPlanilhaPrecificacao() {
  if (!TOKEN) return;
  const ctx = getClienteAtual();
  if (!ctx) { setFeedback("Selecione um cliente para baixar a planilha.", "danger"); return; }
  if (!ctx.hasGrantMl) { setFeedback("Este cliente não possui grant ML conectado.", "danger"); return; }

  const btn = document.getElementById("btn-baixar-planilha-precificacao");
  if (btn) { btn.disabled = true; btn.classList.add("is-loading"); }
  setFeedback("Buscando anúncios ativos e gerando planilha…", "info");

  try {
    const params = new URLSearchParams();
    const contaId = contaIdDoContexto();
    if (contaId) params.set("clienteContaId", String(contaId));
    const res = await fetch(
      `${API_BASE}/automacoes/clientes/${encodeURIComponent(ctx.slug)}/planilha-precificacao.xlsx?${params}`,
      { headers: { Authorization: "Bearer " + TOKEN } }
    );
    if (res.status === 401) { clearSession(); return; }
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      if (res.status === 403 && json?.code !== "CONTA_NAO_PERTENCE_AO_CLIENTE") { window.location.replace("carteira.html"); return; }
      if (json?.code && ["CONTA_AMBIGUA", "CONTA_NAO_PERTENCE_AO_CLIENTE", "MARKETPLACE_INCOMPATIVEL", "CONTA_INATIVA"].includes(json.code)) {
        window.VF?.context?.signalContextError?.({ code: json.code });
      }
      throw new Error(json?.erro || `HTTP ${res.status}`);
    }
    const blob = await res.blob();
    const disp = res.headers.get("content-disposition") || "";
    const nomeMatch = disp.match(/filename="?([^"]+)"?/i);
    const filename = nomeMatch?.[1] || `matriz-precificacao-${ctx.slug}.xlsx`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    setFeedback("Planilha de precificação baixada.", "success");
  } catch (err) {
    setFeedback(`Erro ao baixar a planilha de precificação: ${err.message}`, "danger");
  } finally {
    if (btn) {
      btn.classList.remove("is-loading");
      btn.disabled = !getClienteAtual()?.hasGrantMl;
    }
  }
}

// Modelo destinado exclusivamente à criação da base de custos: contém apenas
// os MLBs ativos e deixa custo, imposto e taxa fixa para preenchimento manual.
async function gerarModeloBaseCustos() {
  if (!TOKEN) return;
  const ctx = getClienteAtual();
  if (!ctx) { setFeedback("Selecione um cliente para gerar o modelo de base.", "danger"); return; }
  if (!ctx.hasGrantMl) { setFeedback("Este cliente não possui grant ML conectado.", "danger"); return; }
  if (ctx.baseStatus !== "ausente") {
    setFeedback("O modelo de base está disponível apenas para clientes sem base MELI vinculada.", "warning");
    return;
  }

  const btn = document.getElementById("btn-gerar-modelo-base");
  if (btn) { btn.disabled = true; btn.classList.add("is-loading"); }
  setFeedback("Buscando IDs dos anúncios ativos e gerando modelo de base…", "info");

  try {
    const params = new URLSearchParams();
    const contaId = contaIdDoContexto();
    if (contaId) params.set("clienteContaId", String(contaId));
    const res = await fetch(
      `${API_BASE}/automacoes/clientes/${encodeURIComponent(ctx.slug)}/modelo-base-custos.xlsx?${params}`,
      { headers: { Authorization: "Bearer " + TOKEN } }
    );
    if (res.status === 401) { clearSession(); return; }
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      if (res.status === 403 && json?.code !== "CONTA_NAO_PERTENCE_AO_CLIENTE") { window.location.replace("carteira.html"); return; }
      if (json?.code && ["CONTA_AMBIGUA", "CONTA_NAO_PERTENCE_AO_CLIENTE", "MARKETPLACE_INCOMPATIVEL", "CONTA_INATIVA"].includes(json.code)) {
        window.VF?.context?.signalContextError?.({ code: json.code });
      }
      throw new Error(json?.erro || `HTTP ${res.status}`);
    }

    const blob = await res.blob();
    const disp = res.headers.get("content-disposition") || "";
    const nomeMatch = disp.match(/filename="?([^";]+)"?/i);
    const filename = nomeMatch?.[1] || `modelo-base-custos-${ctx.slug}.xlsx`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    setFeedback(
      "Modelo de base gerado. Preencha custo, imposto e taxa fixa e importe o arquivo em Bases de Custo.",
      "success"
    );
  } catch (err) {
    setFeedback(`Erro ao gerar o modelo de base: ${err.message}`, "danger");
  } finally {
    const atual = getClienteAtual();
    if (btn) {
      btn.classList.remove("is-loading");
      btn.disabled = !(atual?.hasGrantMl && atual?.baseStatus === "ausente");
    }
  }
}

function novaAnalise() {
  resetResultadoEProcessamento();
  setConfigDisabled(false);
  setFeedback("");
  // Mantém o cliente selecionado; apenas reavalia a prontidão.
  onClienteChange();
}

/* ── CONTEXTO (F5 — vem do Shell V3, não mais desta tela) ────────────────
   Mesmo padrão de fechamentos-api.js:821 / ads.js. O listener é registrado
   AQUI, enquanto o script clássico é avaliado, ou seja ANTES de vf-shell.js
   (module, deferido) rodar — assim nenhum emit se perde, inclusive o
   primeiro, síncrono, de dentro de vfContext.init(). Sem polling.

   Guarda de repetição: `vf:context` também dispara por motivos que não são
   troca de cliente/conta (bandeira de integração, resize do shell); refazer
   a análise nesses casos jogaria fora um resultado na tela.

   Chave por CLIENTE+CONTA (não só cliente): trocar de Mercado Livre 1 para
   Mercado Livre 2 no mesmo cliente é uma chave diferente — precisa
   invalidar a prontidão/resultado exibidos e reconsultar, mesmo sem trocar
   de cliente. Sem isso, o resultado da conta anterior continuaria na tela
   como se fosse da nova (o próprio bug que esta mudança corrige). */
let ultimoContextoAplicado = Symbol("contexto-nao-aplicado-ainda");
document.addEventListener("vf:context", () => {
  const slug = slugDoContexto();
  const contaId = contaIdDoContexto();
  renderIdentidadeCliente();
  const chave = slug ? `${slug}:${contaId || ""}` : "";
  if (chave === ultimoContextoAplicado) return;
  ultimoContextoAplicado = chave;
  loadProntidaoConta(); // zera a prontidão da conta anterior de forma síncrona
  onClienteChange();
});

// ─── Listeners ───────────────────────────────────────────────────────────
document.getElementById("btn-otimizador-analisar")?.addEventListener("click", analisarLoja);
document.getElementById("btn-nova-analise")?.addEventListener("click", novaAnalise);
document.getElementById("btn-baixar-planilha-precificacao")?.addEventListener("click", baixarPlanilhaPrecificacao);
document.getElementById("btn-gerar-modelo-base")?.addEventListener("click", gerarModeloBaseCustos);
document.getElementById("btn-baixar-xlsx")?.addEventListener("click", () => {
  if (RELATORIO_CONCLUIDO_ID) baixarXlsx(RELATORIO_CONCLUIDO_ID);
});
document.getElementById("btn-ver-relatorio-completo")?.addEventListener("click", () => {
  if (!RELATORIO_CONCLUIDO_ID) { window.location.href = "relatorios.html"; return; }
  window.location.href = `relatorios.html?relatorio=${encodeURIComponent(RELATORIO_CONCLUIDO_ID)}`;
});

// ─── Init ────────────────────────────────────────────────────────────────
if (TOKEN) {
  loadClientes();
}
