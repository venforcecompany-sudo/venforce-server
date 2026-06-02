const STORAGE_KEY = "vf-token";
const API_BASE    = "https://venforce-server.onrender.com";
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

// ─── Detecção de marketplace (igual bases.js) ─────────────────────────────────
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

// ─── KPIs a partir de /bases ─────────────────────────────────────────────────
function renderKpis(bases) {
  const total    = bases.length;
  const ativas   = bases.filter(b => b.ativo !== false).length;
  const meli     = bases.filter(b => detectarMarketplace(b) === "meli").length;
  const shopee   = bases.filter(b => detectarMarketplace(b) === "shopee").length;

  const set = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = String(val);
  };

  set("kpi-total-bases",  total);
  set("kpi-bases-ativas", ativas);
  set("kpi-meli",         meli);
  set("kpi-shopee",       shopee);

  const foot = (id, txt) => {
    const el = document.getElementById(id);
    if (el) el.textContent = txt;
  };

  foot("kpi-bases-foot",   total === 0 ? "Nenhuma base importada" : `${ativas} ativa${ativas !== 1 ? "s" : ""}`);
  foot("kpi-ativas-foot",  ativas === total ? "Todas ativas" : `${total - ativas} inativa${total - ativas !== 1 ? "s" : ""}`);
  foot("kpi-meli-foot",    meli === 0 ? "Nenhuma base ML" : `base${meli !== 1 ? "s" : ""} Mercado Livre`);
  foot("kpi-shopee-foot",  shopee === 0 ? "Nenhuma base Shopee" : `base${shopee !== 1 ? "s" : ""} Shopee`);
}

// ─── Status da operação ──────────────────────────────────────────────────────
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

function setOperationCard(key, { label, value, foot, state } = {}) {
  const labelEl = document.getElementById(`op-${key}-label`);
  const valueEl = document.getElementById(`op-${key}-value`);
  const footEl = document.getElementById(`op-${key}-foot`);
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
  const descEl = emptyEl.querySelector(".vf-empty__desc");
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
  const candidates = [
    data?.total,
    data?.pagination?.total,
    data?.paginacao?.total,
    data?.meta?.total,
  ];
  for (const raw of candidates) {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return relatorios.length;
}

function renderOperationRelatorios(data, relatorios) {
  const total = getRelatoriosTotal(data || {}, relatorios || []);
  setOperationCard("reports", {
    value: total,
    foot: total === 0 ? "Nenhum diagnóstico retornado" : `Total retornado por /automacoes/relatorios`,
  });
}

async function loadOperationMlStatus() {
  const cards = ["ml-connected", "ml-pending"];
  try {
    const [clientesData, tokensData] = await Promise.all([
      fetchDashboardJson("/clientes"),
      fetchDashboardJson("/admin/ml-tokens"),
    ]);
    if (!clientesData || !tokensData) return;

    const clientes = extractArray(clientesData, "clientes");
    const clientesAtivos = clientes.filter(c => c.ativo !== false);
    const activeClienteKeys = new Set(clientesAtivos.map(getClienteKey).filter(Boolean));
    const connectedKeys = new Set();

    extractArray(tokensData, "tokens").forEach((row) => {
      if (!isMlTokenActive(row)) return;
      const key = getClienteKey(row);
      if (key && (!activeClienteKeys.size || activeClienteKeys.has(key))) connectedKeys.add(key);
    });

    const conectados = connectedKeys.size;
    const pendentes = Math.max(activeClienteKeys.size - conectados, 0);

    setOperationCard("ml-connected", {
      value: conectados,
      foot: conectados === 0 ? "Nenhum cliente Mercado Livre com token válido" : `Clientes Mercado Livre com token ativo/válido`,
    });
    setOperationCard("ml-pending", {
      value: pendentes,
      foot: pendentes === 0 ? "Nenhum cliente ativo sem token válido" : `Clientes ativos sem token ML válido`,
    });
  } catch (err) {
    const forbidden = err?.status === 403;
    cards.forEach((key) => setOperationCard(key, {
      value: "—",
      foot: forbidden ? "Sem permissão" : "Dados indisponíveis",
      state: forbidden ? "muted" : "error",
    }));
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

// ─── Prioridades ─────────────────────────────────────────────────────────────
function renderPrioridades(bases) {
  const wrap = document.getElementById("dash-prioridades");
  const countEl = document.getElementById("dash-prioridades-count");
  if (!wrap) return;

  const prioridades = [];
  const agora = Date.now();
  const DIAS = 30;

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
      nivel: "is-warning",
      titulo: `${desatualizadas.length} base${desatualizadas.length !== 1 ? "s" : ""} desatualizada${desatualizadas.length !== 1 ? "s" : ""} há mais de ${DIAS} dias`,
      meta: nomes + extra,
      acao: '<a class="vf-btn vf-btn--sm vf-btn--ghost" href="bases.html">Atualizar</a>',
    });
  }

  // Bases sem marketplace identificado
  const semMarketplace = bases.filter(b => detectarMarketplace(b) === "outro");
  if (semMarketplace.length > 0) {
    prioridades.push({
      nivel: "is-info",
      titulo: `${semMarketplace.length} base${semMarketplace.length !== 1 ? "s" : ""} sem marketplace identificado`,
      meta: "Renomeie para incluir _meli ou _shopee",
      acao: '<a class="vf-btn vf-btn--sm vf-btn--ghost" href="bases.html">Ver bases</a>',
    });
  }

  if (prioridades.length === 0) {
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

  wrap.innerHTML = prioridades.map(p => `
    <div class="vf-priority ${escapeHTML(p.nivel)}">
      <span class="vf-pdot"></span>
      <div class="vf-priority__main">
        <div class="vf-priority__title">${p.titulo}</div>
        <div class="vf-priority__meta">${p.meta}</div>
      </div>
      ${p.acao}
    </div>`).join("");

  if (countEl) {
    const cls = prioridades.some(p => p.nivel === "is-danger") ? "is-danger"
              : prioridades.some(p => p.nivel === "is-warning") ? "is-warning"
              : "is-info";
    countEl.className = `vf-tag ${cls}`;
    countEl.textContent = `${prioridades.length} ação${prioridades.length !== 1 ? "ões" : ""}`;
    countEl.style.display = "";
  }
}

// ─── Saúde das bases ──────────────────────────────────────────────────────────
function renderHealth(bases) {
  const wrap = document.getElementById("dash-health");
  const emptyEl = document.getElementById("dash-health-empty");
  if (!wrap) return;

  if (bases.length === 0) {
    wrap.innerHTML = "";
    if (emptyEl) { wrap.appendChild(emptyEl); emptyEl.style.display = ""; }
    return;
  }

  const agora = Date.now();

  // Calcular "saúde" por base: 100% se atualizada há menos de 7 dias,
  // degradando proporcionalmente até 0% aos 90 dias.
  const comSaude = bases.map(b => {
    let pct = 100;
    if (b.updated_at) {
      const diasAtras = (agora - new Date(b.updated_at).getTime()) / (1000 * 60 * 60 * 24);
      if (diasAtras <= 7)        pct = 100;
      else if (diasAtras >= 90)  pct = 0;
      else                       pct = Math.round(100 - ((diasAtras - 7) / 83) * 100);
    }
    if (b.ativo === false) pct = 0;
    return { nome: b.slug || b.nome || "—", pct };
  });

  // Ordenar: piores primeiro
  comSaude.sort((a, b) => a.pct - b.pct);
  // Mostrar no máximo 5
  const exibidas = comSaude.slice(0, 5);

  const htmlItems = exibidas.map(item => {
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

  wrap.innerHTML = htmlItems;
}

// ─── Relatórios recentes ──────────────────────────────────────────────────────
async function loadRelatorios() {
  const tbody  = document.getElementById("dash-relatorios-tbody");
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

    const data = await res.json();
    const relatorios = Array.isArray(data?.relatorios) ? data.relatorios
                     : Array.isArray(data)             ? data
                     : [];
    renderOperationRelatorios(data, relatorios);

    if (relatorios.length === 0) {
      tbody.closest("table").style.display = "none";
      setEmptyState(emptyEl, {
        title: "Nenhum diagnóstico ainda",
        desc: "Rode o primeiro diagnóstico em Automações.",
      });
      if (emptyEl) emptyEl.style.display = "";
      return;
    }

    // Já vem ordenado por created_at DESC do servidor; pegar os 5 primeiros
    const recentes = relatorios.slice(0, 5);

    tbody.innerHTML = recentes.map(r => {
      const data_str = r.created_at
        ? new Date(r.created_at).toLocaleDateString("pt-BR")
        : "—";
      const itens = r.total_itens ?? "—";
      const status = r.status || "concluído";
      const cls = status === "concluído" || status === "ok" ? "is-success"
                : status === "atenção"   || status === "warning" ? "is-warning"
                : status === "crítico"   || status === "error"   ? "is-danger"
                : "";
      const nome = escapeHTML(r.base_slug || r.cliente_slug || "—");
      return `
        <tr>
          <td><b>${nome}</b></td>
          <td class="num">${escapeHTML(String(itens))}</td>
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
    // Sem dados confiáveis — esconde a tabela e mostra empty
    if (tbody) {
      tbody.closest("table").style.display = "none";
    }
    setEmptyState(emptyEl, {
      title: err?.status === 403 ? "Sem permissão" : "Diagnósticos indisponíveis",
      desc: err?.status === 403 ? "Seu usuário não tem acesso aos relatórios." : "Não foi possível carregar os diagnósticos agora.",
      actionHtml: err?.status === 403 ? "" : undefined,
    });
    if (emptyEl) emptyEl.style.display = "";
  }
}

// ─── Carregamento principal ───────────────────────────────────────────────────
async function loadDashboard() {
  if (!TOKEN) return;

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
    const bases = Array.isArray(json?.bases) ? json.bases
                : Array.isArray(json)        ? json
                : [];

    renderKpis(bases);
    renderBanner(bases);
    renderPrioridades(bases);
    renderHealth(bases);
    renderOperationBases(bases);

  } catch (err) {
    // Bases indisponíveis: mostra zeros nos KPIs atuais e erro apenas no card operacional.
    renderKpis([]);
    renderPrioridades([]);
    renderHealth([]);
    setOperationCard("base-clients", {
      value: "—",
      foot: err?.status === 403 ? "Sem permissão" : "Dados indisponíveis",
      state: err?.status === 403 ? "muted" : "error",
    });
  }

  await Promise.allSettled([mlStatusPromise, loadRelatorios()]);
}

// ─── Init ─────────────────────────────────────────────────────────────────────
renderGreeting();
if (TOKEN) loadDashboard();
