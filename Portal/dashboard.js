const STORAGE_KEY = "vf-token";
const API_BASE    = "https://venforce-server.onrender.com";

// ─── Score: pesos (ajustáveis sem tocar na lógica) ────────────────────────────
const PESOS = { ml: 25, basesFrescas: 20, coberturaClientes: 20, diagnosticos: 15, semCriticos: 20 };

// ─── Estado compartilhado entre os loaders ────────────────────────────────────
let _bases = [];
let _priML  = [];   // prioridades vindas de loadOperationMlStatus
let _priRel = [];   // prioridades vindas de loadRelatorios
let _scoreInput = {
  isAdmin: false,
  clientesAtivos: 0, clientesComToken: 0, clientesComBase: 0,
  basesAtivas: 0, basesNaoVencidas: 0,
  diagnosticos30d: 0, relatoriosTotal: 0, relatoriosCriticos: 0,
};

initLayout();

// ─── Sessão ───────────────────────────────────────────────────────────────────
function getToken() {
  const t = localStorage.getItem(STORAGE_KEY);
  if (!t) { window.location.replace("index.html"); return null; }
  return t;
}
const TOKEN = getToken();

function clearSession() {
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem("vf-user");
  window.location.replace("index.html");
}

function escapeHTML(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

// ─── Detecção de marketplace ──────────────────────────────────────────────────
function detectarMarketplace(base) {
  const norm = (v) =>
    String(v || "").toLowerCase().trim()
      .normalize("NFD").replace(/[̀-ͯ]/g, "");

  const rawMp = norm(base?.marketplace);
  if (rawMp) {
    if (rawMp.includes("shopee")) return "shopee";
    if (rawMp.includes("meli") || rawMp.includes("mercado")) return "meli";
  }
  const hay = norm(`${base?.nome || ""} ${base?.slug || ""}`);
  if (hay.includes("shopee")) return "shopee";
  if (hay.includes("meli") || hay.includes("mercado_livre") ||
      hay.includes("mercadolivre") || hay.includes("mlb") ||
      /(^|[_\-\s])ml([_\-\s]|$)/i.test(hay)) return "meli";
  if (hay.includes("shop") || hay.includes("shp") || hay.includes("sp_")) return "shopee";
  return "outro";
}

// ─── Saudação dinâmica ────────────────────────────────────────────────────────
function renderGreeting() {
  try {
    const user = JSON.parse(localStorage.getItem("vf-user") || "{}");
    const hora = new Date().getHours();
    const periodo = hora < 12 ? "Bom dia" : hora < 18 ? "Boa tarde" : "Boa noite";
    const nome = user?.nome || user?.email?.split("@")[0] || "";
    const el = document.getElementById("dash-greeting");
    if (el) el.textContent = nome ? `${periodo}, ${nome}` : `${periodo}!`;
  } catch (_) {}
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function plural(n, singular, pluralForm) {
  return n === 1 ? singular : (pluralForm || `${singular}s`);
}

function extractArray(data, key) {
  if (Array.isArray(data?.[key])) return data[key];
  if (Array.isArray(data)) return data;
  return [];
}

function getClienteKey(row) {
  const id = row?.cliente_id ?? row?.clienteId ?? row?.id;
  if (id != null && id !== "") return `id:${id}`;
  const slug = String(row?.cliente_slug || row?.clienteSlug || row?.slug || "").trim();
  if (slug) return `slug:${slug.toLowerCase()}`;
  const nome = String(row?.cliente_nome || row?.clienteNome || row?.nome || "").trim();
  return nome ? `nome:${nome.toLowerCase()}` : "";
}

function getBaseClienteKey(base) {
  const id = base?.cliente_id ?? base?.clienteId;
  if (id != null && id !== "") return `id:${id}`;
  const slug = String(base?.cliente_slug || base?.clienteSlug || "").trim();
  if (slug) return `slug:${slug.toLowerCase()}`;
  const nome = String(base?.cliente_nome || base?.clienteNome || "").trim();
  return nome ? `nome:${nome.toLowerCase()}` : "";
}

function isMlTokenActive(row) {
  const tokenStatus = String(row?.token_status || row?.status || "").toLowerCase().trim();
  if (["error", "erro", "invalid", "invalido", "expired", "expirado", "revoked"].includes(tokenStatus)) {
    return false;
  }
  const access = String(row?.access_token || "").trim();
  const refresh = String(row?.refresh_token || "").trim();
  if (!access && !refresh) return false;
  const expMs = new Date(row?.expires_at).getTime();
  return Number.isFinite(expMs) && expMs > Date.now();
}

function tempoAtras(iso) {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "agora";
  if (mins < 60) return `há ${mins}min`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `há ${hrs}h`;
  const dias = Math.floor(hrs / 24);
  if (dias === 1) return "ontem";
  if (dias < 7) return `há ${dias} dias`;
  return new Date(iso).toLocaleDateString("pt-BR");
}

function setOperationCard(key, { label, value, foot, state } = {}) {
  const labelEl = document.getElementById(`op-${key}-label`);
  const valueEl = document.getElementById(`op-${key}-value`);
  const footEl  = document.getElementById(`op-${key}-foot`);
  if (labelEl && label) labelEl.textContent = label;
  if (valueEl) {
    valueEl.textContent = value == null ? "—" : String(value);
    valueEl.classList.toggle("is-muted", state === "muted" || state === "error");
  }
  if (footEl) {
    footEl.textContent = foot || "";
    footEl.classList.toggle("is-error", state === "error");
  }
}

function setEmptyState(emptyEl, { title, desc, actionHtml } = {}) {
  if (!emptyEl) return;
  const titleEl = emptyEl.querySelector(".vf-empty__title");
  const descEl  = emptyEl.querySelector(".vf-empty__desc");
  if (titleEl && title) titleEl.textContent = title;
  if (descEl && desc) descEl.textContent = desc;
  const action = emptyEl.querySelector(".vf-btn");
  if (actionHtml === "") action?.remove();
}

async function fetchDashboardJson(path) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}` }
  });
  if (res.status === 401) { clearSession(); return null; }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json().catch(() => ({}));
}

// ─── Score: calcular ─────────────────────────────────────────────────────────
function computeScore(input) {
  const {
    isAdmin, clientesAtivos, clientesComToken, clientesComBase,
    basesAtivas, basesNaoVencidas, diagnosticos30d, relatoriosTotal, relatoriosCriticos,
  } = input;

  // Denominador 0 → fator 1 (neutro, sem penalidade)
  const safe = (n, d) => (d > 0 ? Math.min(1, n / d) : 1);

  const f2 = safe(basesNaoVencidas, basesAtivas);
  // Usa basesAtivas como proxy para clientesAtivos quando não-admin
  const proxyCli = clientesAtivos || basesAtivas;
  const f4 = safe(diagnosticos30d, proxyCli);
  // Sem relatórios → neutro (não há críticos a penalizar)
  const f5 = relatoriosTotal > 0 ? 1 - safe(relatoriosCriticos, relatoriosTotal) : 1;

  if (isAdmin) {
    const f1 = safe(clientesComToken, clientesAtivos);
    const f3 = safe(clientesComBase, clientesAtivos);
    const score = Math.round(
      f1 * PESOS.ml +
      f2 * PESOS.basesFrescas +
      f3 * PESOS.coberturaClientes +
      f4 * PESOS.diagnosticos +
      f5 * PESOS.semCriticos
    );
    return { score, parcial: false };
  }

  // Não-admin: renormaliza pesos disponíveis (basesFrescas+diagnosticos+semCriticos = 55)
  const pesoDisp = PESOS.basesFrescas + PESOS.diagnosticos + PESOS.semCriticos;
  const score = Math.round(
    (f2 * PESOS.basesFrescas + f4 * PESOS.diagnosticos + f5 * PESOS.semCriticos) / pesoDisp * 100
  );
  return { score, parcial: true };
}

// ─── Score: renderizar ────────────────────────────────────────────────────────
function renderScore({ score, parcial }) {
  const valueEl = document.getElementById("op-score-value");
  const badgeEl = document.getElementById("op-score-badge");
  if (!valueEl) return;

  valueEl.textContent = String(score);

  if (badgeEl) {
    const cls   = score >= 80 ? "is-success" : score >= 60 ? "is-warning" : "is-danger";
    const label = score >= 80 ? "Saudável" : score >= 60 ? "Atenção" : "Risco";
    const extra = parcial ? " · parcial" : "";
    badgeEl.innerHTML = `<span class="vf-tag ${cls}">${label}${extra}</span>`;
  }
}

// ─── Banner de bases desatualizadas ──────────────────────────────────────────
function renderBanner(bases) {
  const DIAS_LIMITE = 30;
  const agora = Date.now();
  const desatualizadas = bases.filter(b => {
    if (!b.updated_at) return false;
    const diff = (agora - new Date(b.updated_at).getTime()) / (1000 * 60 * 60 * 24);
    return diff > DIAS_LIMITE;
  });

  const banner = document.getElementById("dash-banner");
  const bannerText = document.getElementById("dash-banner-text");
  if (!banner || !bannerText) return;

  if (desatualizadas.length > 0) {
    const n = desatualizadas.length;
    bannerText.innerHTML = `<b>${n} base${n !== 1 ? "s" : ""}</b> desatualizada${n !== 1 ? "s" : ""} há mais de ${DIAS_LIMITE} dias. Diagnósticos com base velha podem gerar margem incorreta.`;
    banner.style.display = "flex";
  } else {
    banner.style.display = "none";
  }
}

// ─── Prioridades (Faixa 1) ────────────────────────────────────────────────────
// extras = itens vindos de ML/relatorios (tipo: "ml_token","critico","sem_base")
// bases-derived: "base_vencida", "sem_marketplace"
function renderPrioridades(bases, extras = []) {
  const wrap    = document.getElementById("dash-prioridades");
  const countEl = document.getElementById("dash-prioridades-count");
  if (!wrap) return;

  const prioridades = [];
  const agora = Date.now();
  const DIAS  = 30;

  // Bases desatualizadas
  const desatualizadas = bases.filter(b => {
    if (!b.updated_at) return false;
    const diff = (agora - new Date(b.updated_at).getTime()) / (1000 * 60 * 60 * 24);
    return diff > DIAS;
  });
  if (desatualizadas.length > 0) {
    const nomes = desatualizadas.slice(0, 3).map(b => escapeHTML(b.slug || b.nome || "")).join(" · ");
    const extra = desatualizadas.length > 3 ? ` e mais ${desatualizadas.length - 3}` : "";
    prioridades.push({
      tipo: "base_vencida",
      nivel: "is-warning",
      titulo: `${desatualizadas.length} base${desatualizadas.length !== 1 ? "s" : ""} desatualizada${desatualizadas.length !== 1 ? "s" : ""} há mais de ${DIAS} dias`,
      meta: nomes + extra,
      acao: '<a class="vf-btn vf-btn--sm vf-btn--ghost" href="bases.html">Atualizar base</a>',
    });
  }

  // Bases sem marketplace identificado
  const semMarketplace = bases.filter(b => detectarMarketplace(b) === "outro");
  if (semMarketplace.length > 0) {
    prioridades.push({
      tipo: "sem_marketplace",
      nivel: "is-info",
      titulo: `${semMarketplace.length} base${semMarketplace.length !== 1 ? "s" : ""} sem marketplace identificado`,
      meta: "Renomeie para incluir _meli ou _shopee",
      acao: '<a class="vf-btn vf-btn--sm vf-btn--ghost" href="bases.html">Ver bases</a>',
    });
  }

  // Ordenação: token > crítico > sem_base > base_vencida > sem_marketplace
  const ORDER = ["ml_token", "critico", "sem_base", "base_vencida", "sem_marketplace"];
  const all = [...extras, ...prioridades];
  all.sort((a, b) => {
    const ia = ORDER.indexOf(a.tipo ?? "");
    const ib = ORDER.indexOf(b.tipo ?? "");
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });

  if (all.length === 0) {
    wrap.innerHTML = `
      <div class="vf-empty" style="padding:2rem 1.5rem;">
        <div class="vf-empty__ico">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        </div>
        <p class="vf-empty__title">Tudo em ordem</p>
        <p class="vf-empty__desc">Nenhuma prioridade pendente no momento.</p>
      </div>`;
    if (countEl) countEl.style.display = "none";
    return;
  }

  wrap.innerHTML = all.map(p => `
    <div class="vf-priority ${escapeHTML(p.nivel || "")}">
      <span class="vf-pdot"></span>
      <div class="vf-priority__main">
        <div class="vf-priority__title">${p.titulo}</div>
        <div class="vf-priority__meta">${p.meta}</div>
      </div>
      ${p.acao || ""}
    </div>`).join("");

  if (countEl) {
    const cls = all.some(p => p.nivel === "is-danger") ? "is-danger"
              : all.some(p => p.nivel === "is-warning") ? "is-warning"
              : "is-info";
    countEl.className = `vf-tag ${cls}`;
    countEl.textContent = `${all.length} ação${all.length !== 1 ? "ões" : ""}`;
    countEl.style.display = "";
  }
}

// ─── Frescor das bases (Faixa 2, card 2.4) ────────────────────────────────────
function renderHealth(bases) {
  const wrap    = document.getElementById("dash-health");
  const emptyEl = document.getElementById("dash-health-empty");
  if (!wrap) return;

  if (bases.length === 0) {
    wrap.innerHTML = "";
    if (emptyEl) { wrap.appendChild(emptyEl); emptyEl.style.display = ""; }
    return;
  }

  const agora = Date.now();
  const comSaude = bases.map(b => {
    let pct = 100;
    if (b.updated_at) {
      const diasAtras = (agora - new Date(b.updated_at).getTime()) / (1000 * 60 * 60 * 24);
      if (diasAtras <= 7)       pct = 100;
      else if (diasAtras >= 90) pct = 0;
      else                      pct = Math.round(100 - ((diasAtras - 7) / 83) * 100);
    }
    if (b.ativo === false) pct = 0;
    return { nome: b.slug || b.nome || "—", pct };
  });

  comSaude.sort((a, b) => a.pct - b.pct);
  const exibidas = comSaude.slice(0, 5);

  wrap.innerHTML = exibidas.map(item => {
    const cls = item.pct >= 70 ? "" : item.pct >= 40 ? "is-warning" : "is-danger";
    const cor  = item.pct >= 70 ? "var(--vf-success)" : item.pct >= 40 ? "var(--vf-warning)" : "var(--vf-danger)";
    return `
      <div class="vf-health">
        <div class="vf-health__top">
          <span class="vf-health__name">${escapeHTML(item.nome)}</span>
          <span class="vf-health__pct" style="color:${cor};">${item.pct}%</span>
        </div>
        <div class="vf-bar"><div class="vf-bar__fill ${cls}" style="width:${item.pct}%"></div></div>
      </div>`;
  }).join("");
}

// ─── Clientes com base (fallback não-admin) ───────────────────────────────────
function renderOperationBases(bases) {
  const ativas = (bases || []).filter(b => b.ativo !== false);
  const clientesComBase = new Set();
  ativas.forEach((base) => {
    const key = getBaseClienteKey(base);
    if (key) clientesComBase.add(key);
  });

  if (clientesComBase.size > 0) {
    setOperationCard("base-clients", {
      label: "Clientes com base",
      value: clientesComBase.size,
      foot: `${clientesComBase.size} ${plural(clientesComBase.size, "cliente")} com base de custo atrelada`,
    });
    return;
  }

  setOperationCard("base-clients", {
    label: "Bases ativas",
    value: ativas.length,
    foot: ativas.length === 0 ? "Nenhuma base ativa" : "Sem cliente identificável no payload de /bases",
    state: ativas.length === 0 ? "muted" : undefined,
  });
}

function getRelatoriosTotal(data, relatorios) {
  const candidates = [data?.total, data?.pagination?.total, data?.paginacao?.total, data?.meta?.total];
  for (const raw of candidates) {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return relatorios.length;
}

function renderOperationRelatorios(data, relatorios) {
  const total = getRelatoriosTotal(data || {}, relatorios || []);
  // total aparece no rodapé do card de score (via op-reports-value)
  const el = document.getElementById("op-reports-value");
  if (el) el.textContent = String(total);
}

// ─── Status ML + prioridades admin (Faixa 1 + Faixa 2) ───────────────────────
async function loadOperationMlStatus() {
  try {
    const [clientesData, tokensData] = await Promise.all([
      fetchDashboardJson("/clientes"),
      fetchDashboardJson("/admin/ml-tokens"),
    ]);
    if (!clientesData || !tokensData) return;

    const clientes      = extractArray(clientesData, "clientes");
    const clientesAtivos = clientes.filter(c => c.ativo !== false);
    const activeClienteKeys = new Set(clientesAtivos.map(getClienteKey).filter(Boolean));
    const connectedKeys = new Set();
    const agora = Date.now();
    const SETE_DIAS = 7 * 24 * 60 * 60 * 1000;
    let tokensProblem = 0;

    extractArray(tokensData, "tokens").forEach((row) => {
      const active = isMlTokenActive(row);
      const expMs  = new Date(row?.expires_at).getTime();

      if (!active) {
        tokensProblem++;
        return;
      }
      // Expirando em menos de 7 dias (ainda válido mas prestes a expirar)
      if (Number.isFinite(expMs) && expMs - agora < SETE_DIAS) {
        tokensProblem++;
      }
      const key = getClienteKey(row);
      if (key && (!activeClienteKeys.size || activeClienteKeys.has(key))) {
        connectedKeys.add(key);
      }
    });

    const conectados = connectedKeys.size;
    const pendentes  = Math.max(activeClienteKeys.size - conectados, 0);

    // Clientes com base (cruzar com _bases já carregadas)
    const basesClienteKeys = new Set();
    _bases.filter(b => b.ativo !== false).forEach(b => {
      const k = getBaseClienteKey(b);
      if (k) basesClienteKeys.add(k);
    });
    const comBase = clientesAtivos.filter(c => basesClienteKeys.has(getClienteKey(c))).length;
    const semBase = clientesAtivos.length - comBase;

    // Preencher _scoreInput (admin)
    _scoreInput.isAdmin          = true;
    _scoreInput.clientesAtivos   = clientesAtivos.length;
    _scoreInput.clientesComToken = conectados;
    _scoreInput.clientesComBase  = comBase;

    // Prioridade: tokens ML com problema
    if (tokensProblem > 0) {
      _priML.push({
        tipo: "ml_token",
        nivel: "is-danger",
        titulo: `${tokensProblem} token${tokensProblem !== 1 ? "s" : ""} ML expirado${tokensProblem !== 1 ? "s" : ""} ou expirando`,
        meta: "Diagnóstico e Ads não rodam sem token válido",
        acao: '<a class="vf-btn vf-btn--sm vf-btn--ghost" href="ml-tokens.html">Reconectar token</a>',
      });
    }

    // Prioridade: clientes sem base
    if (semBase > 0) {
      _priML.push({
        tipo: "sem_base",
        nivel: "is-warning",
        titulo: `${semBase} cliente${semBase !== 1 ? "s" : ""} ativo${semBase !== 1 ? "s" : ""} sem base de custo`,
        meta: "Sem custo cadastrado não é possível gerar diagnóstico confiável",
        acao: '<a class="vf-btn vf-btn--sm vf-btn--ghost" href="bases.html">Vincular base</a>',
      });
    }

    // Cards da Faixa 2
    setOperationCard("ml-connected", {
      value: conectados,
      foot: conectados === 0 ? "Nenhum cliente ML com token válido" : "Clientes Mercado Livre com token ativo",
    });
    setOperationCard("ml-pending", {
      value: pendentes,
      foot: pendentes === 0 ? "Nenhum cliente ativo sem token válido" : "Clientes ativos sem token ML válido",
    });
    setOperationCard("base-clients", {
      label: "Clientes com base",
      value: comBase,
      foot: `${comBase} ${plural(comBase, "cliente")} com base de custo atrelada`,
    });

  } catch (err) {
    const forbidden = err?.status === 403;
    ["ml-connected", "ml-pending"].forEach((key) =>
      setOperationCard(key, {
        value: "—",
        foot: forbidden ? "Sem permissão" : "Dados indisponíveis",
        state: forbidden ? "muted" : "error",
      })
    );
    // base-clients permanece como estimado por renderOperationBases (chamado antes)
  }
}

// ─── Diagnósticos recentes + prioridades (Faixa 3 + Faixa 1) ─────────────────
async function loadRelatorios() {
  const tbody   = document.getElementById("dash-relatorios-tbody");
  const emptyEl = document.getElementById("dash-relatorios-empty");
  if (!tbody) return;

  try {
    const res = await fetch(`${API_BASE}/automacoes/relatorios`, {
      headers: { Authorization: `Bearer ${TOKEN}` }
    });
    if (res.status === 401) { clearSession(); return; }
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }

    const data      = await res.json();
    const relatorios = Array.isArray(data?.relatorios) ? data.relatorios
                      : Array.isArray(data)            ? data
                      : [];

    renderOperationRelatorios(data, relatorios);

    // _scoreInput: relatorios
    const agora = Date.now();
    const TRINTA = 30 * 24 * 60 * 60 * 1000;
    _scoreInput.relatoriosTotal    = relatorios.length;
    _scoreInput.relatoriosCriticos = relatorios.filter(r => (r.itens_criticos ?? 0) > 0).length;
    _scoreInput.diagnosticos30d    = relatorios.filter(r => {
      if (!r.created_at) return false;
      return (agora - new Date(r.created_at).getTime()) < TRINTA;
    }).length;

    // Prioridade: relatórios com itens críticos
    if (_scoreInput.relatoriosCriticos > 0) {
      const n = _scoreInput.relatoriosCriticos;
      _priRel.push({
        tipo: "critico",
        nivel: "is-danger",
        titulo: `${n} relatório${n !== 1 ? "s" : ""} com itens críticos`,
        meta: "Itens sangrando margem aguardam revisão",
        acao: '<a class="vf-btn vf-btn--sm vf-btn--ghost" href="relatorios.html">Ver relatório</a>',
      });
    }

    if (relatorios.length === 0) {
      tbody.closest("table").style.display = "none";
      setEmptyState(emptyEl, {
        title: "Nenhum diagnóstico ainda",
        desc: "Rode o primeiro diagnóstico em Automações.",
      });
      if (emptyEl) emptyEl.style.display = "";
      return;
    }

    const recentes = relatorios.slice(0, 5);

    tbody.innerHTML = recentes.map(r => {
      const data_str      = r.created_at ? new Date(r.created_at).toLocaleDateString("pt-BR") : "—";
      const itens         = r.total_itens ?? "—";
      const criticos_num  = r.itens_criticos ?? null;
      const status        = r.status || "concluído";
      const cls = status === "concluído" || status === "ok"         ? "is-success"
                : status === "atenção"   || status === "warning"    ? "is-warning"
                : status === "crítico"   || status === "error"      ? "is-danger"
                : "";
      const critStyle = (typeof criticos_num === "number" && criticos_num > 0)
        ? ' style="color:var(--vf-danger,#e53935);font-weight:600;"' : "";
      const critTxt = criticos_num != null ? escapeHTML(String(criticos_num)) : "—";
      const nome = escapeHTML(r.base_slug || r.cliente_slug || "—");
      return `
        <tr>
          <td><b>${nome}</b></td>
          <td class="num">${escapeHTML(String(itens))}</td>
          <td class="num"${critStyle}>${critTxt}</td>
          <td class="muted" style="font-size:.8rem;">${escapeHTML(data_str)}</td>
          <td><span class="vf-tag ${cls}">${escapeHTML(status)}</span></td>
        </tr>`;
    }).join("");

    tbody.closest("table").style.display = "";
    if (emptyEl) emptyEl.style.display = "none";

  } catch (err) {
    setOperationCard("reports", {
      value: "—",
      foot: err?.status === 403 ? "Sem permissão" : "Dados indisponíveis",
      state: err?.status === 403 ? "muted" : "error",
    });
    if (tbody) tbody.closest("table").style.display = "none";
    setEmptyState(emptyEl, {
      title: err?.status === 403 ? "Sem permissão" : "Diagnósticos indisponíveis",
      desc: err?.status === 403
        ? "Seu usuário não tem acesso aos relatórios."
        : "Não foi possível carregar os diagnósticos agora.",
      actionHtml: err?.status === 403 ? "" : undefined,
    });
    if (emptyEl) emptyEl.style.display = "";
  }
}

// ─── Timeline de ações (Faixa 3, admin only) ──────────────────────────────────
async function loadTimeline() {
  const section = document.getElementById("dash-timeline-section");
  const list    = document.getElementById("dash-timeline");
  if (!section || !list) return;

  try {
    const res = await fetch(`${API_BASE}/admin/logs?limit=6`, {
      headers: { Authorization: `Bearer ${TOKEN}` }
    });
    if (res.status === 401) { clearSession(); return; }
    if (res.status === 403) { section.style.display = "none"; return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    const logs  = Array.isArray(data?.logs) ? data.logs : [];

    if (logs.length === 0) {
      list.innerHTML = '<p style="padding:1rem 1.5rem;font-size:.85rem;color:var(--vf-muted,#888);">Nenhuma atividade recente.</p>';
      return;
    }

    list.innerHTML = logs.map(log => {
      const tempo     = tempoAtras(log.created_at);
      const statusCls = log.status === "sucesso" ? "is-success" : log.status === "falha" ? "is-danger" : "";
      return `
        <div class="vf-priority">
          <span class="vf-pdot ${statusCls}"></span>
          <div class="vf-priority__main">
            <div class="vf-priority__title">${escapeHTML(log.acao || "—")}</div>
            <div class="vf-priority__meta">${escapeHTML(log.user_nome || "—")} · ${escapeHTML(tempo)}</div>
          </div>
        </div>`;
    }).join("");

  } catch (_) {
    section.style.display = "none";
  }
}

// ─── Carregamento principal ───────────────────────────────────────────────────
async function loadDashboard() {
  if (!TOKEN) return;

  // Reset estado compartilhado
  _bases = [];
  _priML = [];
  _priRel = [];
  _scoreInput = {
    isAdmin: false,
    clientesAtivos: 0, clientesComToken: 0, clientesComBase: 0,
    basesAtivas: 0, basesNaoVencidas: 0,
    diagnosticos30d: 0, relatoriosTotal: 0, relatoriosCriticos: 0,
  };

  const mlStatusPromise = loadOperationMlStatus();

  try {
    const res = await fetch(`${API_BASE}/bases`, {
      headers: { Authorization: `Bearer ${TOKEN}` }
    });
    if (res.status === 401) { clearSession(); return; }
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }

    const json = await res.json();
    _bases = Array.isArray(json?.bases) ? json.bases
           : Array.isArray(json)        ? json
           : [];

    // Score input das bases
    const agora     = Date.now();
    const basesAtiv = _bases.filter(b => b.ativo !== false);
    _scoreInput.basesAtivas      = basesAtiv.length;
    _scoreInput.basesNaoVencidas = basesAtiv.filter(b => {
      if (!b.updated_at) return true; // sem data → não penaliza
      return (agora - new Date(b.updated_at).getTime()) / 86400000 <= 30;
    }).length;

    renderBanner(_bases);
    renderHealth(_bases);
    renderOperationBases(_bases); // fallback não-admin para op-base-clients

  } catch (err) {
    _bases = [];
    renderBanner([]);
    renderHealth([]);
    setOperationCard("base-clients", {
      value: "—",
      foot: err?.status === 403 ? "Sem permissão" : "Dados indisponíveis",
      state: err?.status === 403 ? "muted" : "error",
    });
  }

  await Promise.allSettled([mlStatusPromise, loadRelatorios()]);

  // Todos os dados coletados — renderizar prioridades e score de uma vez
  renderPrioridades(_bases, [..._priML, ..._priRel]);
  renderScore(computeScore(_scoreInput));
  loadTimeline();
}

// ─── Init ─────────────────────────────────────────────────────────────────────
renderGreeting();
if (TOKEN) loadDashboard();
