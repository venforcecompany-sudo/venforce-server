const STORAGE_KEY = "vf-token";
const API_BASE = "https://venforce-server.onrender.com";
initLayout();

function getToken() {
  const t = localStorage.getItem(STORAGE_KEY);
  if (!t) { window.location.replace("index.html"); return null; }
  return t;
}
const TOKEN = getToken();

function escapeHTML(s) {
  const d = document.createElement("div");
  d.textContent = s == null ? "" : String(s);
  return d.innerHTML;
}

const stateLoading = document.getElementById("state-loading");
const stateList = document.getElementById("state-list");
const stateEmpty = document.getElementById("state-empty");
const stateError = document.getElementById("state-error");
const contasList = document.getElementById("contas-list");
const retryBtn = document.getElementById("btn-retry");

function showLoading() {
  stateLoading.style.display = "flex";
  stateList.style.display = stateEmpty.style.display = stateError.style.display = "none";
}
function showList() {
  stateList.style.display = "block";
  stateLoading.style.display = stateEmpty.style.display = stateError.style.display = "none";
}
function showEmpty() {
  stateEmpty.style.display = "block";
  stateLoading.style.display = stateList.style.display = stateError.style.display = "none";
}
function showError(msg) {
  stateError.style.display = "block";
  stateLoading.style.display = stateList.style.display = stateEmpty.style.display = "none";
  document.getElementById("error-message").textContent = msg;
}

function fmtPct(v) {
  const n = Number(v) || 0;
  return `${n.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}

function getMcBadgeClass(mc) {
  const n = Number(mc) || 0;
  if (n >= 20) return "badge-green";
  if (n >= 10) return "badge-yellow";
  return "badge-red";
}

function formatDate(ts) {
  return new Date(ts).toLocaleString("pt-BR");
}

async function loadScans() {
  if (!TOKEN) return;
  showLoading();
  try {
    const res = await fetch(`${API_BASE}/scans`, {
      headers: { Authorization: `Bearer ${TOKEN}` }
    });
    if (res.status === 401) { window.location.replace("index.html"); return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json().catch(() => ({}));
    const scans = Array.isArray(data.scans) ? data.scans : [];
    const contasMap = processarScans(scans);
    calcularResumoGeral(contasMap);
    renderContas(contasMap);
  } catch (err) {
    showError("Não foi possível carregar os scans. Tente novamente.");
  }
}

function processarScans(scans) {
  const map = new Map();

  (Array.isArray(scans) ? scans : []).forEach((s) => {
    const conta = (s?.conta_ml || "—").toString().trim() || "—";
    const createdAt = s?.created_at || s?.createdAt || s?.ts || s?.timestamp;
    const ts = createdAt ? new Date(createdAt).getTime() : NaN;

    const total = Number(s?.total_anuncios ?? 0) || 0;
    const mc = Number(s?.mc_medio ?? 0) || 0;
    const saudaveis = Number(s?.saudaveis ?? 0) || 0;
    const atencao = Number(s?.atencao ?? 0) || 0;
    const criticos = Number(s?.criticos ?? 0) || 0;

    if (!map.has(conta)) {
      map.set(conta, {
        total: 0,
        mc_medio: 0,
        saudaveis: 0,
        atencao: 0,
        criticos: 0,
        count: 0,
        ultimo: null,
        scans: [],
        _mcPeso: 0
      });
    }

    const agg = map.get(conta);
    agg.total += total;
    agg.saudaveis += saudaveis;
    agg.atencao += atencao;
    agg.criticos += criticos;
    agg.count += 1;
    agg._mcPeso += mc * total;

    const scanItem = {
      created_at: createdAt || null,
      ts: Number.isFinite(ts) ? ts : null,
      total,
      mc_medio: mc,
      saudaveis,
      atencao,
      criticos
    };
    agg.scans.push(scanItem);

    if (Number.isFinite(ts)) {
      if (!agg.ultimo || ts > agg.ultimo) agg.ultimo = ts;
    }
  });

  for (const [, v] of map.entries()) {
    v.mc_medio = v.total > 0 ? (v._mcPeso / v.total) : 0;
    v.scans.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    delete v._mcPeso;
  }

  return map;
}

function calcularResumoGeral(contasMap) {
  const contas = Array.from(contasMap.values());
  const totalContas = contasMap.size;
  const totalAnuncios = contas.reduce((acc, c) => acc + (Number(c.total) || 0), 0);
  const mcPesoTotal = contas.reduce((acc, c) => acc + ((Number(c.mc_medio) || 0) * (Number(c.total) || 0)), 0);
  const mcGeral = totalAnuncios > 0 ? (mcPesoTotal / totalAnuncios) : 0;
  const contasCriticas = contas.reduce((acc, c) => acc + ((Number(c.mc_medio) || 0) < 10 ? 1 : 0), 0);

  document.getElementById("summary-contas").textContent = String(totalContas);
  document.getElementById("summary-total").textContent = String(totalAnuncios);
  document.getElementById("summary-mc").textContent = fmtPct(mcGeral);
  document.getElementById("summary-criticas").textContent = String(contasCriticas);
}

function renderContas(contasMap) {
  contasList.innerHTML = "";

  if (!contasMap || contasMap.size === 0) {
    showEmpty();
    return;
  }

  const contas = Array.from(contasMap.entries())
    .sort((a, b) => ((b[1].ultimo || 0) - (a[1].ultimo || 0)));

  contas.forEach(([conta, info]) => {
    const card = document.createElement("div");
    card.className = "vf-conta-card";

    const badgeClass = getMcBadgeClass(info.mc_medio);
    const ultimoTxt = info.ultimo ? formatDate(info.ultimo) : "—";

    const scansId = `scans-${Math.random().toString(16).slice(2)}`;
    const btnId = `btn-${Math.random().toString(16).slice(2)}`;

    card.innerHTML = `
      <div class="vf-conta-header">
        <div class="vf-conta-nome">${escapeHTML(conta)}</div>
        <span class="${escapeHTML(badgeClass)}">${escapeHTML(fmtPct(info.mc_medio))}</span>
      </div>

      <div class="vf-conta-grid">
        <div class="vf-conta-stat">
          <div class="vf-conta-stat-num">${escapeHTML(String(info.total || 0))}</div>
          <div class="vf-conta-stat-lbl">Total anúncios</div>
        </div>
        <div class="vf-conta-stat">
          <div class="vf-conta-stat-num">${escapeHTML(fmtPct(info.mc_medio))}</div>
          <div class="vf-conta-stat-lbl">MC médio</div>
        </div>
        <div class="vf-conta-stat">
          <div class="vf-conta-stat-num">${escapeHTML(String(info.saudaveis || 0))}</div>
          <div class="vf-conta-stat-lbl">Saudáveis</div>
        </div>
        <div class="vf-conta-stat">
          <div class="vf-conta-stat-num">${escapeHTML(String(info.criticos || 0))}</div>
          <div class="vf-conta-stat-lbl">Críticos</div>
        </div>
      </div>

      <div class="vf-conta-footer">
        <div>${escapeHTML(String(info.count || 0))} scans realizados · Último: ${escapeHTML(ultimoTxt)}</div>
        <button type="button" class="vf-btn-secondary" id="${escapeHTML(btnId)}" style="padding:0.45rem 0.75rem;">Ver scans</button>
      </div>

      <div class="vf-scans-lista" id="${escapeHTML(scansId)}"></div>
    `;

    const scansBox = card.querySelector(`#${CSS.escape(scansId)}`);
    const btn = card.querySelector(`#${CSS.escape(btnId)}`);

    scansBox.innerHTML = buildScansTable(info.scans || []);

    btn.addEventListener("click", () => {
      const open = scansBox.classList.toggle("open");
      btn.textContent = open ? "Ocultar scans" : "Ver scans";
    });

    contasList.appendChild(card);
  });

  showList();
}

function buildScansTable(scans) {
  const rows = (Array.isArray(scans) ? scans : []).map((s) => {
    const when = s?.created_at ? formatDate(s.created_at) : "—";
    const mc = Number(s?.mc_medio ?? 0) || 0;
    const cls = getMcBadgeClass(mc);
    return `
      <tr>
        <td style="color:var(--vf-text-m);font-size:.875rem;">${escapeHTML(when)}</td>
        <td style="text-align:right;color:var(--vf-text-m);font-family:var(--vf-mono);font-size:.8rem;">${escapeHTML(String(s?.total ?? 0))}</td>
        <td style="text-align:center;"><span class="${escapeHTML(cls)}">${escapeHTML(fmtPct(mc))}</span></td>
        <td style="text-align:right;color:var(--vf-text-m);font-family:var(--vf-mono);font-size:.8rem;">${escapeHTML(String(s?.saudaveis ?? 0))}</td>
        <td style="text-align:right;color:var(--vf-text-m);font-family:var(--vf-mono);font-size:.8rem;">${escapeHTML(String(s?.atencao ?? 0))}</td>
        <td style="text-align:right;color:var(--vf-text-m);font-family:var(--vf-mono);font-size:.8rem;">${escapeHTML(String(s?.criticos ?? 0))}</td>
      </tr>
    `;
  }).join("");

  return `
    <div class="vf-table-wrapper">
      <table class="vf-table">
        <thead>
          <tr>
            <th>Data</th>
            <th style="text-align:right;">Total</th>
            <th style="text-align:center;">MC Médio</th>
            <th style="text-align:right;">Saudáveis</th>
            <th style="text-align:right;">Atenção</th>
            <th style="text-align:right;">Críticos</th>
          </tr>
        </thead>
        <tbody>
          ${rows || ""}
        </tbody>
      </table>
    </div>
  `;
}

retryBtn.addEventListener("click", loadScans);
if (TOKEN) loadScans();

