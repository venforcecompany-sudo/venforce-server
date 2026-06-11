(function () {
  "use strict";

  const API_BASE = "https://venforce-server.onrender.com";
  const TOKEN_KEY = "vf-token";
  const USER_KEY = "vf-user";
  const ADMIN_ROLES = new Set(["adm", "admin", "administrator"]);

  const state = {
    token: "",
    user: null,
    clientes: [],
    payload: null,
    loading: false,
  };

  document.addEventListener("DOMContentLoaded", boot);

  function boot() {
    const root = getRoot();
    const auth = readAuth();

    if (!auth.token) {
      root.innerHTML = gateHtml("Você precisa estar logado para acessar esta DevUI.");
      return;
    }

    if (!auth.isAdmin) {
      root.innerHTML = gateHtml(
        "Acesso restrito a administradores.<br>Esta DevUI é interna e só pode ser usada por ADM."
      );
      return;
    }

    state.token = auth.token;
    state.user = auth.user;
    renderShell();
    loadClientes();
  }

  function getRoot() {
    return document.getElementById("c360dev-root");
  }

  function readAuth() {
    const token = localStorage.getItem(TOKEN_KEY) || "";
    let user = {};
    try {
      user = JSON.parse(localStorage.getItem(USER_KEY) || "{}") || {};
    } catch {
      user = {};
    }
    const role = String(user.role || "").trim().toLowerCase();
    return { token, user, role, isAdmin: ADMIN_ROLES.has(role) };
  }

  function gateHtml(message) {
    return `
      <article class="c360dev-panel c360dev-gate">
        <h2>Acesso bloqueado</h2>
        <p>${message}</p>
      </article>
    `;
  }

  function renderShell() {
    const user = state.user || {};
    getRoot().innerHTML = `
      <section class="c360dev-panel">
        <div class="c360dev-badges">
          <span class="c360dev-badge ok">ADM validado</span>
          <span class="c360dev-badge">Fetch somente GET</span>
          <span class="c360dev-badge">API: ${esc(API_BASE)}</span>
        </div>
        <p class="c360dev-muted">
          Usuario: ${esc(user.nome || user.email || "sem nome")} · Role: ${esc(user.role || "sem role")}
        </p>
      </section>

      <section class="c360dev-panel">
        <h2>Consulta</h2>
        <form id="c360dev-form" class="c360dev-controls">
          <label>
            Cliente
            <select id="c360dev-client" required>
              <option value="">Carregando clientes...</option>
            </select>
          </label>
          <label>
            Competencia
            <input id="c360dev-competencia" type="month" aria-label="Competencia">
          </label>
          <button id="c360dev-load" type="submit">Carregar</button>
          <button id="c360dev-clear" type="button" class="secondary">Limpar competencia</button>
        </form>
      </section>

      <section id="c360dev-status" class="c360dev-panel" hidden></section>
      <section id="c360dev-summary"></section>
      <section id="c360dev-json-panel" class="c360dev-panel" hidden>
        <h2>JSON bruto</h2>
        <pre id="c360dev-json" class="c360dev-json"></pre>
      </section>
    `;

    document.getElementById("c360dev-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const slug = document.getElementById("c360dev-client").value;
      const competencia = document.getElementById("c360dev-competencia").value;
      if (slug) loadCliente360(slug, competencia);
    });

    document.getElementById("c360dev-clear").addEventListener("click", () => {
      document.getElementById("c360dev-competencia").value = "";
    });
  }

  async function loadClientes() {
    setStatus("Carregando clientes...", "info");
    try {
      const data = await apiGet("/operacao/cliente-360/clientes");
      const clientes = Array.isArray(data?.clientes) ? data.clientes : (Array.isArray(data) ? data : []);
      state.clientes = clientes.filter((cliente) => cliente && cliente.ativo !== false);
      renderClientes();
      setStatus(`${state.clientes.length} clientes carregados.`, "ok");
    } catch (err) {
      renderClientes([]);
      setStatus(`Falha ao carregar clientes: ${err.message}`, "danger");
    }
  }

  async function loadCliente360(slug, competencia) {
    const path = competencia
      ? `/operacao/cliente-360/${encodeURIComponent(slug)}?competencia=${encodeURIComponent(competencia)}`
      : `/operacao/cliente-360/${encodeURIComponent(slug)}`;

    setLoading(true);
    setStatus(`Carregando ${slug}...`, "info");
    try {
      const payload = await apiGet(path);
      state.payload = payload;
      renderPayload(payload);
      setStatus("Payload carregado com sucesso.", "ok");
    } catch (err) {
      state.payload = null;
      renderPayload(null);
      setStatus(`Falha ao carregar Cliente 360: ${err.message}`, "danger");
    } finally {
      setLoading(false);
    }
  }

  async function apiGet(path) {
    const response = await fetch(API_BASE + path, {
      method: "GET",
      headers: { Authorization: `Bearer ${state.token}` },
    });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    if (!response.ok) {
      const message = data?.erro || data?.message || `HTTP ${response.status}`;
      throw new Error(message);
    }
    return data;
  }

  function renderClientes() {
    const select = document.getElementById("c360dev-client");
    const options = state.clientes
      .slice()
      .sort((a, b) => String(a.nome || "").localeCompare(String(b.nome || "")))
      .map((cliente) => `<option value="${esc(cliente.slug)}">${esc(cliente.nome || cliente.slug)}</option>`)
      .join("");

    select.innerHTML = `<option value="">Selecione...</option>${options}`;
  }

  function renderPayload(payload) {
    const summary = document.getElementById("c360dev-summary");
    const jsonPanel = document.getElementById("c360dev-json-panel");
    const json = document.getElementById("c360dev-json");

    if (!payload) {
      summary.innerHTML = "";
      jsonPanel.hidden = true;
      json.textContent = "";
      return;
    }

    summary.innerHTML = `
      <div class="c360dev-grid">
        ${card("Cliente", kv({
          Nome: payload.cliente?.nome,
          Slug: payload.cliente?.slug,
          Ativo: boolText(payload.cliente?.ativo),
          Fonte: payload.fonte,
        }))}
        ${card("Periodo", kv({
          Competencia: payload.periodo?.competencia,
          Label: payload.periodo?.label,
          Tipo: payload.periodo?.tipo,
          Padrao: boolText(payload.periodo?.padrao),
        }))}
        ${card("Sync", kv({
          Status: payload.sync?.status,
          "Precisa sincronizar": boolText(payload.sync?.precisaSincronizar),
          "Ultima sincronizacao": payload.sync?.ultimaSincronizacao,
          Motivo: payload.sync?.motivo,
        }))}
        ${card("Resumo mensal", kv({
          Faturamento: money(payload.resumoMes?.faturamento),
          Pedidos: number(payload.resumoMes?.pedidos),
          Cancelados: number(payload.resumoMes?.cancelados),
          "Ads investido": money(payload.resumoMes?.adsInvestido),
          TACoS: pct(payload.resumoMes?.tacos),
        }))}
        ${card("MC", kv({
          "MC diagnostico": pct(payload.resumoMes?.mcDiagnostico),
          "Fonte diagnostico": payload.resumoMes?.mcDiagnosticoFonte,
          "MC periodo": pct(payload.resumoMes?.mcPeriodo),
          "Fonte periodo": payload.resumoMes?.mcPeriodoFonte,
        }))}
        ${card("Grant e setup", kv({
          Grant: boolText(payload.grant?.temGrant),
          "Status grant": payload.grant?.status,
          "Setup score": number(payload.setup?.score),
          "Saude": payload.saude?.label || payload.saude?.status,
        }))}
        ${card("Grafico", kv({
          Competencia: payload.grafico?.competencia,
          Fonte: payload.grafico?.fonte,
          "Pontos": Array.isArray(payload.grafico?.serieDiaria) ? payload.grafico.serieDiaria.length : null,
          "Motivo indisponivel": payload.grafico?.motivoIndisponivel,
        }))}
        ${card("Cobertura base/faturamento", renderCoberturaResumo(payload.coberturaBaseFaturamento))}
        ${card("Diagnostico", kv({
          Issues: Array.isArray(payload.diagnostico?.issues) ? payload.diagnostico.issues.length : null,
          Oportunidades: Array.isArray(payload.diagnostico?.oportunidades) ? payload.diagnostico.oportunidades.length : null,
          Acoes: Array.isArray(payload.diagnostico?.acoes) ? payload.diagnostico.acoes.length : null,
          "Ultimo salvo": payload.diagnostico?.ultimo?.id,
        }))}
      </div>
      ${renderSnapshots(payload.snapshotsDisponiveis)}
      ${renderProdutosSemBase(payload.coberturaBaseFaturamento)}
    `;

    json.textContent = JSON.stringify(payload, null, 2);
    jsonPanel.hidden = false;
  }

  function renderCoberturaResumo(cobertura) {
    if (!cobertura) return kv({ Disponivel: "sem bloco" });
    if (!cobertura.disponivel) {
      return kv({
        Disponivel: "nao",
        Motivo: cobertura.motivo,
        Mensagem: cobertura.mensagem,
      });
    }
    return kv({
      Disponivel: "sim",
      Competencia: cobertura.periodo?.competencia,
      Confianca: cobertura.fonte?.confianca,
      "Faturamento analisado": money(cobertura.resumo?.faturamentoAnalisado),
      "Sem base": money(cobertura.resumo?.faturamentoSemBase),
      "% sem base": pct(cobertura.resumo?.pctSemBase),
    });
  }

  function renderSnapshots(snapshots) {
    if (!Array.isArray(snapshots) || !snapshots.length) {
      return `
        <section class="c360dev-panel">
          <h2>Snapshots</h2>
          <p class="c360dev-empty">Nenhum snapshot disponivel no payload.</p>
        </section>
      `;
    }

    const rows = snapshots.map((snap) => `
      <tr>
        <td>${esc(snap.competencia)}</td>
        <td>${esc(snap.label)}</td>
        <td>${esc(snap.tipo)}</td>
        <td>${esc(snap.sincronizadoEm)}</td>
        <td>${esc(boolText(snap.temSerieDiaria))}</td>
      </tr>
    `).join("");

    return `
      <section class="c360dev-panel">
        <h2>Snapshots</h2>
        <div class="c360dev-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Competencia</th>
                <th>Label</th>
                <th>Tipo</th>
                <th>Sincronizado em</th>
                <th>Serie diaria</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </section>
    `;
  }

  function renderProdutosSemBase(cobertura) {
    const produtos = cobertura?.produtosSemBaseMaisRelevantes;
    if (!Array.isArray(produtos) || !produtos.length) return "";

    const rows = produtos.map((produto) => `
      <tr>
        <td>${esc(produto.mlb || "-")}</td>
        <td>${esc(produto.sku || "-")}</td>
        <td>${esc(produto.titulo || "-")}</td>
        <td>${money(produto.faturamento)}</td>
        <td>${number(produto.unidades)}</td>
      </tr>
    `).join("");

    return `
      <section class="c360dev-panel">
        <h2>Produtos sem base mais relevantes</h2>
        <div class="c360dev-table-wrap">
          <table>
            <thead>
              <tr>
                <th>MLB</th>
                <th>SKU</th>
                <th>Titulo</th>
                <th>Faturamento</th>
                <th>Unidades</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </section>
    `;
  }

  function card(title, body) {
    return `
      <article class="c360dev-card">
        <h3>${esc(title)}</h3>
        ${body}
      </article>
    `;
  }

  function kv(data) {
    const rows = Object.entries(data).map(([key, value]) => `
      <div>
        <dt>${esc(key)}</dt>
        <dd>${esc(display(value))}</dd>
      </div>
    `).join("");
    return `<dl class="c360dev-kv">${rows}</dl>`;
  }

  function setStatus(message, tone) {
    const status = document.getElementById("c360dev-status");
    if (!status) return;
    const badgeClass = tone === "danger" ? "danger" : (tone === "ok" ? "ok" : "warn");
    status.hidden = false;
    status.innerHTML = `<span class="c360dev-badge ${badgeClass}">${esc(message)}</span>`;
  }

  function setLoading(isLoading) {
    state.loading = isLoading;
    const button = document.getElementById("c360dev-load");
    if (!button) return;
    button.disabled = isLoading;
    button.textContent = isLoading ? "Carregando..." : "Carregar";
  }

  function display(value) {
    if (value === null || value === undefined || value === "") return "-";
    return value;
  }

  function boolText(value) {
    if (value === null || value === undefined) return null;
    return value ? "sim" : "nao";
  }

  function number(value) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return null;
    return Number(value).toLocaleString("pt-BR");
  }

  function money(value) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return null;
    return Number(value).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  }

  function pct(value) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return null;
    return `${Number(value).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
  }

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#39;",
    }[char]));
  }
})();
