/* ================================================================
   seller.js — VenForce · Área do Seller (Fase 1)
   ----------------------------------------------------------------
   Tela isolada (sem sidebar interna). O seller loga com o login
   normal e vê SOMENTE os produtos sem base do cliente vinculado a
   ele (vínculo validado no backend via seller_clientes — o
   cliente_slug daqui é só conveniência, nunca autoridade).

   Honestidade do dado: sem faturamento por produto → "—" e aviso,
   nunca R$ 0,00 inventado.
   ================================================================ */

const API_BASE = "https://venforce-server.onrender.com";
const TOKEN = localStorage.getItem("vf-token") || "";

/* Sem token → volta para o login. */
if (!TOKEN) window.location.replace("index.html");

/* ── HELPERS ─────────────────────────────────────────────── */
const esc = s => String(s ?? "").replace(/[&<>"']/g,
  c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n, d = 0) => (Number(n) || 0).toLocaleString("pt-BR",
  { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtBRL = n => "R$ " + fmt(n, 2);
const valOr = (n, f) => (n === null || n === undefined) ? "—" : f(n);

const PLACEHOLDER_IMG = "data:image/svg+xml," + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" rx="10" fill="#eef0f4"/><path d="M30 62l12-16 9 11 6-7 9 12z" fill="#c4cad6"/><circle cx="36" cy="34" r="6" fill="#c4cad6"/></svg>`);

/* ── STATE ───────────────────────────────────────────────── */
const S = {
  user: null,
  clientes: [],          // vínculos do usuário logado
  clienteSlug: null,     // loja selecionada
  filtro: "",            // '', sem_envio, pendente, aprovado, rejeitado
  busca: "",
  page: 1,
  data: null,            // última resposta de /seller/produtos-sem-base
  salvando: new Set(),   // itemIds com POST em andamento
};

/* ── API ─────────────────────────────────────────────────── */
async function api(path) {
  try {
    const r = await fetch(API_BASE + path, { headers: { Authorization: "Bearer " + TOKEN } });
    const data = await r.json().catch(() => null);
    return { ok: r.ok, status: r.status, data };
  } catch { return { ok: false, status: 0, data: null }; }
}
async function apiPost(path, body) {
  try {
    const r = await fetch(API_BASE + path, {
      method: "POST",
      headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    const data = await r.json().catch(() => null);
    return { ok: r.ok, status: r.status, data };
  } catch { return { ok: false, status: 0, data: null }; }
}

/* ── BOOT ────────────────────────────────────────────────── */
async function initSeller() {
  document.getElementById("sl-logout").addEventListener("click", () => {
    localStorage.removeItem("vf-token");
    localStorage.removeItem("vf-user");
    window.location.replace("index.html");
  });

  const me = await api("/seller/me");

  if (me.status === 401) { window.location.replace("index.html"); return; }
  if (me.status === 403) {
    // Role interna comum caiu aqui por engano → manda para o portal.
    window.location.replace("painel-contas.html");
    return;
  }
  if (!me.ok || !me.data?.ok) {
    mostrarBloqueio("Não foi possível carregar seus dados", "Tente recarregar a página. Se continuar, fale com a equipe VenForce.");
    return;
  }

  S.user = me.data.user;
  S.clientes = me.data.clientes || [];

  // Admin pode inspecionar qualquer loja via ?cliente=<slug>.
  const urlCliente = new URLSearchParams(window.location.search).get("cliente");
  const isAdmin = String(S.user.role || "").toLowerCase() === "admin";

  if (S.clientes.length) {
    S.clienteSlug = (urlCliente && S.clientes.some(c => c.slug === urlCliente))
      ? urlCliente : S.clientes[0].slug;
  } else if (isAdmin && urlCliente) {
    S.clienteSlug = urlCliente;
  } else if (isAdmin) {
    mostrarBloqueio("Modo admin", "Informe a loja na URL: <code>seller.html?cliente=slug-do-cliente</code>, ou crie um vínculo seller para este usuário.");
    return;
  } else {
    mostrarBloqueio("Sua conta ainda não está vinculada a uma loja",
      "Peça à equipe VenForce para vincular seu usuário à sua loja. Depois disso, seus produtos sem custo aparecem aqui.");
    return;
  }

  renderStoreSelect();
  bindControles();
  await carregarProdutos();
}

function mostrarBloqueio(titulo, htmlSeguro) {
  document.getElementById("sl-loading").style.display = "none";
  document.getElementById("sl-content").style.display = "none";
  const el = document.getElementById("sl-blocked");
  el.style.display = "block";
  el.innerHTML = `
    <div class="sl-blocked-icon">🔒</div>
    <h2>${esc(titulo)}</h2>
    <p>${htmlSeguro}</p>`;
}

/* ── SELETOR DE LOJA (só quando há mais de um vínculo) ───── */
function renderStoreSelect() {
  const wrap = document.getElementById("sl-store-wrap");
  if (!wrap) return;
  if (S.clientes.length > 1) {
    wrap.innerHTML = `
      <select id="sl-store-select" class="sl-input sl-select" aria-label="Trocar loja">
        ${S.clientes.map(c =>
          `<option value="${esc(c.slug)}" ${c.slug === S.clienteSlug ? "selected" : ""}>${esc(c.nome)}</option>`).join("")}
      </select>`;
    document.getElementById("sl-store-select").addEventListener("change", e => {
      S.clienteSlug = e.target.value;
      S.page = 1;
      carregarProdutos();
    });
  } else {
    const nome = S.clientes[0]?.nome || S.clienteSlug || "";
    wrap.innerHTML = nome ? `<span class="sl-store-name">${esc(nome)}</span>` : "";
  }
}

/* ── CONTROLES (busca + filtros) ─────────────────────────── */
let buscaTimer = null;
function bindControles() {
  document.getElementById("sl-busca").addEventListener("input", e => {
    clearTimeout(buscaTimer);
    buscaTimer = setTimeout(() => {
      S.busca = e.target.value.trim();
      S.page = 1;
      carregarProdutos();
    }, 350);
  });
}

const FILTROS = [
  { id: "",          label: "Todos" },
  { id: "sem_envio", label: "Sem custo" },
  { id: "pendente",  label: "Enviados" },
  { id: "aprovado",  label: "Aprovados" },
  { id: "rejeitado", label: "Rejeitados" },
];
function renderFiltros() {
  const r = S.data?.resumo || {};
  const counts = {
    "": r.totalSemBase, sem_envio: null, pendente: r.enviadosPendentes,
    aprovado: r.aprovados, rejeitado: r.rejeitados,
  };
  const el = document.getElementById("sl-filtros");
  el.innerHTML = FILTROS
    .filter(f => f.id !== "rejeitado" || (r.rejeitados || 0) > 0)
    .map(f => {
      const n = counts[f.id];
      return `<button type="button" class="sl-pill ${S.filtro === f.id ? "active" : ""}" data-filtro="${f.id}">
        ${f.label}${n != null ? ` <b>${fmt(n)}</b>` : ""}</button>`;
    }).join("");
  el.querySelectorAll(".sl-pill").forEach(btn =>
    btn.addEventListener("click", () => {
      S.filtro = btn.dataset.filtro;
      S.page = 1;
      carregarProdutos();
    }));
}

/* ── CARREGAR PRODUTOS ───────────────────────────────────── */
async function carregarProdutos() {
  const list = document.getElementById("sl-list");
  const empty = document.getElementById("sl-empty");
  list.classList.add("sl-dim");

  const qs = new URLSearchParams({ page: String(S.page), limit: "30" });
  if (S.clienteSlug) qs.set("cliente_slug", S.clienteSlug);
  if (S.filtro) qs.set("status", S.filtro);
  if (S.busca) qs.set("busca", S.busca);

  const res = await api(`/seller/produtos-sem-base?${qs}`);
  list.classList.remove("sl-dim");

  if (res.status === 401) { window.location.replace("index.html"); return; }
  if (res.status === 403) {
    mostrarBloqueio("Acesso não autorizado",
      esc(res.data?.erro || "Você não tem acesso a esta loja."));
    return;
  }
  if (!res.ok || !res.data?.ok) {
    mostrarBloqueio("Não foi possível carregar os produtos", "Tente recarregar a página.");
    return;
  }

  S.data = res.data;
  document.getElementById("sl-loading").style.display = "none";
  document.getElementById("sl-blocked").style.display = "none";
  document.getElementById("sl-content").style.display = "block";

  document.getElementById("sl-store-name").textContent = S.data.cliente?.nome || "—";
  renderChips();
  renderBanner();
  renderFiltros();
  renderLista();
  renderPaging();
  empty.style.display = S.data.produtos.length ? "none" : "block";
  if (!S.data.produtos.length) renderEmpty();
}

/* ── CHIPS DE RESUMO ─────────────────────────────────────── */
function renderChips() {
  const r = S.data.resumo || {};
  const chip = (val, lbl, cls = "") =>
    `<div class="sl-chip ${cls}"><b>${fmt(val)}</b><span>${lbl}</span></div>`;
  document.getElementById("sl-chips").innerHTML =
    chip(r.totalSemBase, "sem custo", (r.totalSemBase || 0) > 0 ? "warn" : "ok") +
    chip(r.prioritarios, "prioritários (venderam)", (r.prioritarios || 0) > 0 ? "hot" : "") +
    chip(r.enviadosPendentes, "aguardando revisão") +
    chip(r.aprovados, "aprovados", (r.aprovados || 0) > 0 ? "ok" : "");
}

/* ── BANNER DE CONTEXTO ──────────────────────────────────── */
function renderBanner() {
  const el = document.getElementById("sl-banner");
  const avisos = [];
  if (!S.data.baseVinculada) {
    avisos.push(`<div class="sl-banner crit">Esta loja ainda não tem base oficial vinculada.
      A equipe VenForce precisa vincular uma base antes de aplicar os custos enviados —
      você já pode preencher normalmente.</div>`);
  }
  if (!S.data.relatorio) {
    avisos.push(`<div class="sl-banner">Ainda não há diagnóstico para esta loja —
      por isso não há produtos para listar.</div>`);
  } else if (!S.data.periodoFaturamento) {
    avisos.push(`<div class="sl-banner">Encontramos produtos sem custo, mas ainda não há
      faturamento por produto para priorizar. A lista segue a ordem do diagnóstico mais recente.</div>`);
  }
  el.innerHTML = avisos.join("");
}

/* ── LISTA DE PRODUTOS ───────────────────────────────────── */
const STATUS_FILA = {
  sem_envio: { label: "sem custo cadastrado", cls: "warn" },
  pendente:  { label: "enviado · aguardando revisão", cls: "info" },
  aprovado:  { label: "custo aprovado e aplicado na base", cls: "ok" },
  aplicado:  { label: "custo aprovado e aplicado na base", cls: "ok" },
  rejeitado: { label: "envio rejeitado — reenvie corrigido", cls: "crit" },
};

function renderLista() {
  const list = document.getElementById("sl-list");
  const periodoLbl = S.data.periodoFaturamento?.label || null;

  list.innerHTML = S.data.produtos.map(p => {
    const st = STATUS_FILA[p.statusFila] || STATUS_FILA.sem_envio;
    const sub = p.submissao;
    const enviado = p.statusFila === "pendente";
    const aprovado = p.statusFila === "aprovado" || p.statusFila === "aplicado";
    const idSafe = esc(p.itemId);

    const venda = p.faturamentoPeriodo !== null
      ? `Vendeu ${periodoLbl ? "em " + esc(periodoLbl) : "no período"}:
         <b>${fmtBRL(p.faturamentoPeriodo)}</b> · ${fmt(p.unidadesPeriodo || 0)} un.`
      : `<span class="sl-muted">Sem dado de venda por produto no período.</span>`;

    const form = aprovado ? "" : `
      <div class="sl-form ${enviado ? "sl-form-locked" : ""}" data-form="${idSafe}">
        <div class="sl-fields">
          <label class="sl-field">
            <span>Custo do produto *</span>
            <input type="text" inputmode="decimal" data-campo="custo" placeholder="0,00"
                   value="${sub && sub.custoProduto != null ? esc(fmt(sub.custoProduto, 2)) : ""}" ${enviado ? "disabled" : ""}>
          </label>
          <label class="sl-field">
            <span>Imposto %</span>
            <input type="text" inputmode="decimal" data-campo="imposto" placeholder="0,0"
                   value="${sub && sub.impostoPercentual != null ? esc(fmt(sub.impostoPercentual, 2)) : ""}" ${enviado ? "disabled" : ""}>
          </label>
          <label class="sl-field">
            <span>Taxa fixa</span>
            <input type="text" inputmode="decimal" data-campo="taxa" placeholder="0,00"
                   value="${sub && sub.taxaFixa != null ? esc(fmt(sub.taxaFixa, 2)) : ""}" ${enviado ? "disabled" : ""}>
          </label>
          <label class="sl-field sl-field-obs">
            <span>Observação</span>
            <input type="text" maxlength="1000" data-campo="obs" placeholder="opcional"
                   value="${sub && sub.observacao ? esc(sub.observacao) : ""}" ${enviado ? "disabled" : ""}>
          </label>
        </div>
        <div class="sl-form-actions">
          ${enviado
            ? `<span class="sl-sent-note">Custo enviado. Aguardando revisão da operação.</span>
               <button type="button" class="sl-btn sl-btn-ghost" data-editar="${idSafe}">Editar envio</button>`
            : `<button type="button" class="sl-btn sl-btn-primary" data-salvar="${idSafe}">
                 ${p.statusFila === "rejeitado" ? "Reenviar custo" : "Salvar custo"}</button>
               <span class="sl-form-msg" data-msg="${idSafe}"></span>`}
        </div>
      </div>`;

    return `
    <article class="sl-card" data-item="${idSafe}">
      <div class="sl-card-top">
        <img class="sl-thumb" loading="lazy" alt=""
             src="${p.thumbnail ? esc(p.thumbnail) : PLACEHOLDER_IMG}"
             onerror="this.src='${PLACEHOLDER_IMG}'">
        <div class="sl-card-info">
          <div class="sl-card-title">${esc(p.titulo || "(sem título)")}
            ${p.prioridade === "alta" ? `<span class="sl-tag hot">prioritário</span>` : ""}</div>
          <div class="sl-card-meta">
            <span class="sl-mono">${esc(p.itemId)}</span>
            ${p.sku ? `<span>SKU: <span class="sl-mono">${esc(p.sku)}</span></span>` : ""}
            ${p.precoAtual !== null ? `<span>Preço atual: <b>${fmtBRL(p.precoAtual)}</b></span>` : ""}
            ${p.permalink ? `<a href="${esc(p.permalink)}" target="_blank" rel="noopener">ver anúncio ↗</a>` : ""}
          </div>
          <div class="sl-card-venda">${venda}</div>
          <div class="sl-status ${st.cls}">${st.label}</div>
          ${p.statusFila === "rejeitado" && sub?.motivoRejeicao
            ? `<div class="sl-motivo">Motivo: ${esc(sub.motivoRejeicao)}</div>` : ""}
        </div>
      </div>
      ${form}
    </article>`;
  }).join("");

  list.querySelectorAll("[data-salvar]").forEach(btn =>
    btn.addEventListener("click", () => salvarCusto(btn.dataset.salvar, btn)));
  list.querySelectorAll("[data-editar]").forEach(btn =>
    btn.addEventListener("click", () => destravarForm(btn.dataset.editar)));
}

function renderEmpty() {
  const el = document.getElementById("sl-empty");
  if (S.busca || S.filtro) {
    el.innerHTML = `<div class="sl-empty-icon">🔎</div>
      <b>Nada encontrado com esse filtro</b>
      <p>Tente limpar a busca ou voltar para "Todos".</p>`;
  } else {
    el.innerHTML = `<div class="sl-empty-icon">✅</div>
      <b>Tudo certo por enquanto</b>
      <p>Não há produtos sem custo para preencher nesta loja.</p>`;
  }
}

/* ── PAGINAÇÃO ───────────────────────────────────────────── */
function renderPaging() {
  const pg = S.data.paging;
  const el = document.getElementById("sl-paging");
  if (!pg || pg.totalPages <= 1) { el.innerHTML = ""; return; }
  el.innerHTML = `
    <button type="button" class="sl-btn sl-btn-ghost" ${pg.page <= 1 ? "disabled" : ""} data-pg="${pg.page - 1}">← Anterior</button>
    <span>Página ${pg.page} de ${pg.totalPages} · ${fmt(pg.total)} produto(s)</span>
    <button type="button" class="sl-btn sl-btn-ghost" ${pg.page >= pg.totalPages ? "disabled" : ""} data-pg="${pg.page + 1}">Próxima →</button>`;
  el.querySelectorAll("[data-pg]").forEach(btn =>
    btn.addEventListener("click", () => {
      S.page = parseInt(btn.dataset.pg, 10) || 1;
      carregarProdutos();
      window.scrollTo({ top: 0, behavior: "smooth" });
    }));
}

/* ── SALVAR CUSTO ────────────────────────────────────────── */
function parseNum(v) {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const n = Number(s.replace(/\./g, "").replace(",", ".")); // aceita 1.234,56
  return Number.isFinite(n) ? n : NaN;
}

function destravarForm(itemId) {
  const card = document.querySelector(`.sl-card[data-item="${CSS.escape(itemId)}"]`);
  if (!card) return;
  card.querySelectorAll("input").forEach(i => { i.disabled = false; });
  const actions = card.querySelector(".sl-form-actions");
  actions.innerHTML = `
    <button type="button" class="sl-btn sl-btn-primary" data-salvar="${esc(itemId)}">Salvar alteração</button>
    <span class="sl-form-msg" data-msg="${esc(itemId)}"></span>`;
  actions.querySelector("[data-salvar]")
    .addEventListener("click", e => salvarCusto(itemId, e.currentTarget));
  card.querySelector(".sl-form")?.classList.remove("sl-form-locked");
}

async function salvarCusto(itemId, btn) {
  if (S.salvando.has(itemId)) return;
  const card = document.querySelector(`.sl-card[data-item="${CSS.escape(itemId)}"]`);
  if (!card) return;
  const msg = card.querySelector(`[data-msg]`);
  const get = campo => card.querySelector(`input[data-campo="${campo}"]`)?.value;

  const custo = parseNum(get("custo"));
  const imposto = parseNum(get("imposto"));
  const taxa = parseNum(get("taxa"));

  const falha = t => { if (msg) { msg.textContent = t; msg.className = "sl-form-msg crit"; } };
  if (custo === null || Number.isNaN(custo) || custo <= 0) return falha("Informe um custo maior que zero.");
  if (Number.isNaN(imposto) || (imposto !== null && (imposto < 0 || imposto > 100))) return falha("Imposto deve estar entre 0 e 100.");
  if (Number.isNaN(taxa) || (taxa !== null && taxa < 0)) return falha("Taxa fixa não pode ser negativa.");

  const produto = (S.data.produtos || []).find(p => p.itemId === itemId);

  S.salvando.add(itemId);
  btn.disabled = true;
  const txtOrig = btn.textContent;
  btn.textContent = "Enviando…";
  if (msg) { msg.textContent = ""; msg.className = "sl-form-msg"; }

  const res = await apiPost("/seller/custos", {
    cliente_slug: S.clienteSlug,
    item_id: itemId,
    sku: produto?.sku || null,
    titulo: produto?.titulo || null,
    custo_produto: custo,
    imposto_percentual: imposto,
    taxa_fixa: taxa,
    observacao: get("obs") || null,
  });

  S.salvando.delete(itemId);
  btn.disabled = false;
  btn.textContent = txtOrig;

  if (res.status === 401) { window.location.replace("index.html"); return; }
  if (!res.ok || !res.data?.ok) {
    return falha(res.data?.erro || "Não foi possível enviar. Tente novamente.");
  }

  // Recarrega a lista para refletir o status pendente persistido no servidor.
  await carregarProdutos();
}

/* ── START ───────────────────────────────────────────────── */
initSeller();
